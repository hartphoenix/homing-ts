import { createApp } from "./app";
import { getConfig } from "./config";

const config = getConfig();
const app = createApp();

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
