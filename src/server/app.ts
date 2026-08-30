import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { type AgentCoreRouterOptions, createAgentCoreRouter } from "./agent/router";
import { createV2Router, type V2RouterDependencies } from "./agent/v2/router";
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
  spaIndex?: () => Response | Promise<Response>;
  auth?: AuthRouterDependencies;
  v2?: Omit<V2RouterDependencies, "auth">;
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
  const spaIndex =
    dependencies.spaIndex ??
    (async () =>
      typeof Bun === "undefined"
        ? new Response(await readFile("dist/client/index.html"), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          })
        : new Response(Bun.file("dist/client/index.html")));

  app.use("*", requestId({ headerName: "X-Request-ID", limitLength: 80 }));
  app.use("*", requestLogger());
  app.use("*", async (context, next) => {
    context.set("requestId", context.get("requestId"));
    context.header("X-Request-ID", context.get("requestId"));
    await next();
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
  app.use("/api/*", async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (context) =>
        context.json(
          {
            error: {
              code: "payload_too_large",
              message: "The request body is too large.",
              fields: {},
              request_id: context.get("requestId"),
            },
          },
          413,
        ),
    }),
  );

  app.get("/health/live", (context) => context.json({ status: "ok" }));
  app.get("/health/ready", async (context) => {
    if (!(await ready())) {
      throw new HomingError("not_ready", "Database unavailable.", 503);
    }
    return context.json({ status: "ready" });
  });

  if (dependencies.auth) {
    if (dependencies.v2) {
      app.route("/api/v1", createV2Router({ ...dependencies.v2, auth: dependencies.auth }));
    }
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

    // `/agent-setup/SKILL.md` is a public kit compatibility redirect, but the
    // bare route is a browser page. Register the exact SPA entries before the
    // kit wildcard so direct navigation and refresh do not become JSON 404s.
    app.on(["GET", "HEAD"], "/agent-setup", spaIndex);
    app.on(["GET", "HEAD"], "/agent-setup/", spaIndex);

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
  const backgroundFiles = new Set([
    "exterior-golden-stoop.jpg",
    "exterior-leafy-block.jpg",
    "interior-brownstone.jpg",
    "interior-staircase.jpg",
  ]);
  app.on(["GET", "HEAD"], "/backgrounds/:name", async (context) => {
    const name = context.req.param("name");
    if (!backgroundFiles.has(name)) {
      throw new HomingError("not_found", "Object not found.", 404);
    }
    const candidates = [`dist/client/backgrounds/${name}`, `public/backgrounds/${name}`];
    let file: Bun.BunFile | null = null;
    for (const candidate of candidates) {
      const current = Bun.file(candidate);
      if (await current.exists()) {
        file = current;
        break;
      }
    }
    if (!file) throw new HomingError("not_found", "Object not found.", 404);
    return new Response(context.req.method === "HEAD" ? null : file, {
      headers: {
        "Cache-Control": "public, max-age=86400",
        "Content-Type": "image/jpeg",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.get("*", spaIndex);

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
