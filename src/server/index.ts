import { createPostgresAgentServices } from "./agent/postgres-repository";
import { createApp } from "./app";
import { DrizzleAuthRepository } from "./auth/drizzle-repository";
import { PostgresCollaborationRepository } from "./collaboration/postgres-repository";
import { getConfig } from "./config";

const config = getConfig();
const agentServices = createPostgresAgentServices();
const app = createApp({
  auth: {
    repo: new DrizzleAuthRepository(),
    origin: config.PUBLIC_ORIGIN,
    sessionDays: config.SESSION_DAYS,
    tokenDays: config.AGENT_TOKEN_DAYS,
    throttleKey: config.AUTH_THROTTLE_KEY,
  },
  agent: {
    runs: { service: agentServices.runs },
    changes: { service: agentServices.changes },
    sourcePlans: { service: agentServices.sourcePlans, origin: config.PUBLIC_ORIGIN },
    kit: { origin: config.PUBLIC_ORIGIN },
  },
  collaboration: { repository: new PostgresCollaborationRepository() },
});

const server = Bun.serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port: config.PORT,
});

console.log(
  JSON.stringify({
    level: "info",
    event: "server_started",
    port: server.port,
    origin: config.PUBLIC_ORIGIN,
  }),
);
