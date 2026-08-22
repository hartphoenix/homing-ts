import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { registerAgentKitRoutes } from "./agentkit/package";
import { getDatabase } from "./db/client";
import { errorResponse, HomingError } from "./http";
import { requestLogger } from "./logging";
import type { AppVariables } from "./types";

type AppDependencies = {
  ready?: () => Promise<boolean>;
  publicOrigin?: string;
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

  registerAgentKitRoutes(app, dependencies.publicOrigin ?? "http://localhost:8000");

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
