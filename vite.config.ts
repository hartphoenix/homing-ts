import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "./src/dev/demo-accounts.ts";

const devProxyTarget = process.env.HOMING_DEV_PROXY_TARGET ?? "http://127.0.0.1:8000";

function demoCredentials() {
  return {
    name: "homing-demo-credentials",
    configureServer() {
      console.info(
        `\n  Demo users: ${DEMO_ACCOUNTS.map(({ email }) => email).join(", ")}\n  Demo password: ${DEMO_PASSWORD}\n`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), demoCredentials()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": devProxyTarget,
      "^/agent(?:/|$)": devProxyTarget,
      "/health": devProxyTarget,
    },
  },
});
