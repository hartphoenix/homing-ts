import { Hono } from "hono";

import { type ChangeRouterOptions, createChangeRouter } from "./changes";
import { createKitRouter, type KitRouterOptions } from "./kit";
import { createPostgresAgentServices } from "./postgres-repository";
import { createRunRouter, type RunRouterOptions } from "./runs";
import { createSourcePlanRouter, type SourcePlanRouterOptions } from "./source-plans";

export type AgentCoreRouterOptions = {
  principal: RunRouterOptions["principal"];
  runs?: Omit<RunRouterOptions, "principal">;
  changes?: Omit<ChangeRouterOptions, "principal">;
  sourcePlans?: Omit<SourcePlanRouterOptions, "principal">;
  kit?: KitRouterOptions;
};

export function createAgentApiRouter(options: Omit<AgentCoreRouterOptions, "kit">): Hono {
  const app = new Hono();
  if (options.runs)
    app.route("/", createRunRouter({ ...options.runs, principal: options.principal }));
  if (options.changes)
    app.route("/", createChangeRouter({ ...options.changes, principal: options.principal }));
  if (options.sourcePlans)
    app.route(
      "/",
      createSourcePlanRouter({ ...options.sourcePlans, principal: options.principal }),
    );
  return app;
}

/** A complete mountable slice: public kit routes at root, private API routes under /api/v1. */
export function createAgentCoreRouter(options: AgentCoreRouterOptions): Hono {
  const app = new Hono();
  if (options.kit) app.route("/", createKitRouter(options.kit));
  app.route("/api/v1", createAgentApiRouter(options));
  return app;
}

export type PostgresAgentCoreRouterOptions = {
  principal: RunRouterOptions["principal"];
  origin: string;
};

/** Production-ready composition for one root mount before the application's catchalls. */
export function createPostgresAgentCoreRouter(options: PostgresAgentCoreRouterOptions): Hono {
  const services = createPostgresAgentServices();
  return createAgentCoreRouter({
    principal: options.principal,
    runs: { service: services.runs },
    changes: { service: services.changes },
    sourcePlans: { service: services.sourcePlans, origin: options.origin },
    kit: { origin: options.origin },
  });
}
