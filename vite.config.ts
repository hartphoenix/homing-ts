import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const devProxyTarget = process.env.HOMING_DEV_PROXY_TARGET ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
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
