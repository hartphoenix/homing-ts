import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { type AgentCoreRouterOptions, createAgentCoreRouter } from "./agent/router";
import {
  type AuthContext,
  type AuthRouterDependencies,
  assertSessionMutation,
  createAuthRouter,
  resolvePrincipal,
} from "./auth/router";
import { createCollaborationRouter } from "./collaboration/router";
import type { CollaborationDependencies } from "./collaboration/types";
import { getDatabase } from "./db/client";
import { errorResponse, HomingError } from "./http";
import { requestLogger } from "./logging";
import type { AppVariables } from "./types";

type AppDependencies = {
  ready?: () => Promise<boolean>;
  auth?: AuthRouterDependencies;
  agent?: Omit<AgentCoreRouterOptions, "principal">;
  collaboration?: Omit<CollaborationDependencies, "principal">;
};

async function databaseReady(): Promise<boolean> {
  try {
    await getDatabase().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

export function createApp(dependencies: AppDependencies = {}) {
  const app = new Hono<{ Variables: AppVariables }>();
  const ready = dependencies.ready ?? databaseReady;

  app.use("*", requestId({ headerName: "X-Request-ID", limitLength: 80 }));
  app.use("*", requestLogger());
  app.use("*", async (context, next) => {
    context.set("requestId", context.get("requestId"));
    await next();
    context.header("X-Request-ID", context.get("requestId"));
  });
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
      crossOriginResourcePolicy: "same-origin",
      referrerPolicy: "same-origin",
      strictTransportSecurity: "max-age=31536000; includeSubDomains",
      xFrameOptions: "DENY",
    }),
  );
  app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));

  app.get("/health/live", (context) => context.json({ status: "ok" }));
  app.get("/health/ready", async (context) => {
    if (!(await ready())) {
      throw new HomingError("not_ready", "Database unavailable.", 503);
    }
    return context.json({ status: "ready" });
  });

  if (dependencies.auth) {
    app.route("/api/v1", createAuthRouter(dependencies.auth));

    const authenticated = async (context: AuthContext) => {
      const principal = await resolvePrincipal(
        context,
        dependencies.auth as AuthRouterDependencies,
      );
      if (
        principal.kind === "session" &&
        !["GET", "HEAD", "OPTIONS"].includes(context.req.method)
      ) {
        await assertSessionMutation(context, dependencies.auth as AuthRouterDependencies);
      }
      return principal;
    };

    if (dependencies.agent) {
      app.route(
        "/",
        createAgentCoreRouter({
          ...dependencies.agent,
          principal: async (context) => {
            const principal = await authenticated(context as AuthContext);
            return {
              userId: principal.user.id,
              tokenId: principal.token?.id ?? null,
              scopes: principal.scopes,
              projectIds: principal.token?.projectIds ?? [],
            };
          },
        }),
      );
    }

    if (dependencies.collaboration) {
      app.route(
        "/api/v1",
        createCollaborationRouter({
          ...dependencies.collaboration,
          principal: async (context) => {
            const principal = await authenticated(context as AuthContext);
            return {
              userId: principal.user.id,
              email: principal.user.email,
              projectIds: principal.token?.projectIds ?? [],
              scopes: principal.scopes,
              authKind: principal.kind === "session" ? "session" : "bearer",
              ...(principal.token ? { tokenId: principal.token.id } : {}),
            };
          },
        }),
      );
    }
  }

  app.all("/api/*", () => {
    throw new HomingError("not_found", "Object not found.", 404);
  });

  app.get("/assets/*", async (context) => {
    const relativePath = context.req.path.slice(1);
    if (!/^assets\/[A-Za-z0-9._-]+$/.test(relativePath)) {
      throw new HomingError("not_found", "Object not found.", 404);
    }
    const file = Bun.file(`dist/client/${relativePath}`);
    if (!(await file.exists())) {
      throw new HomingError("not_found", "Object not found.", 404);
    }
    return new Response(file);
  });
  app.get("*", async () => new Response(Bun.file("dist/client/index.html")));

  app.notFound((context) =>
    errorResponse(context, new HomingError("not_found", "Object not found.", 404)),
  );
  app.onError((error, context) => {
    if (error instanceof HomingError) {
      return errorResponse(context, error);
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "request_failed",
        request_id: context.get("requestId"),
        error: error.name,
      }),
    );
    return errorResponse(
      context,
      new HomingError("server_error", "The request could not be completed.", 500),
    );
  });

  return app;
}

export type HomingApp = ReturnType<typeof createApp>;
