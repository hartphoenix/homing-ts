import { defineConfig, devices } from "@playwright/test";

const databaseUrl = process.env.HOMING_TEST_DATABASE_URL;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  ...(databaseUrl
    ? {
        webServer: {
          command: "bun src/server/index.ts",
          env: {
            ...process.env,
            AUTH_THROTTLE_KEY: "homing-playwright-test-throttle-key",
            DATABASE_URL: databaseUrl,
            NODE_ENV: "test",
            PORT: new URL(baseURL).port || "8000",
            PUBLIC_ORIGIN: baseURL,
          },
          reuseExistingServer: false,
          timeout: 30_000,
          url: `${baseURL}/health/ready`,
        },
      }
    : {}),
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
