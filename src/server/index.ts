import { createPostgresAgentServices } from "./agent/postgres-repository";
import { createApp } from "./app";
import { DrizzleAuthRepository } from "./auth/drizzle-repository";
import { PostgresCollaborationRepository } from "./collaboration/postgres-repository";
import { type AppConfig, getConfig } from "./config";
import { seedDemoAccounts } from "./db/seed-demo";

const config = getConfig();

function assertDeploymentConfig(appConfig: AppConfig): void {
  const origin = new URL(appConfig.PUBLIC_ORIGIN);
  const localHttpOrigin =
    origin.protocol === "http:" &&
    (origin.hostname === "localhost" ||
      origin.hostname === "127.0.0.1" ||
      origin.hostname === "[::1]");

  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      "PUBLIC_ORIGIN must be a bare origin without credentials, path, query, or hash.",
    );
  }

  if (appConfig.NODE_ENV === "production" && origin.protocol !== "https:" && !localHttpOrigin) {
    throw new Error(
      "PUBLIC_ORIGIN must use HTTPS in production (HTTP is permitted only for localhost rehearsal).",
    );
  }

  if (appConfig.NODE_ENV === "production" && process.env.HOMING_DEMO_ACCOUNTS === "1") {
    throw new Error("HOMING_DEMO_ACCOUNTS=1 is not permitted in production.");
  }
}

assertDeploymentConfig(config);

if (process.env.HOMING_DEMO_ACCOUNTS === "1") await seedDemoAccounts();

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
