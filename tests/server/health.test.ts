import { describe, expect, it } from "vitest";

import { createApp } from "../../src/server/app";

describe("health endpoints", () => {
  it("reports liveness", async () => {
    const response = await createApp({ ready: async () => true }).request("/health/live");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("reports readiness failure without exposing details", async () => {
    const response = await createApp({ ready: async () => false }).request("/health/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "not_ready" } });
  });
});
