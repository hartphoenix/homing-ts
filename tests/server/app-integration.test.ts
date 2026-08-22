import { describe, expect, it } from "vitest";

import { ChangeService, InMemoryChangeRepository } from "../../src/server/agent/changes";
import { createApp } from "../../src/server/app";
import type { AuthRepository } from "../../src/server/auth/repository";
import { InMemoryCollaborationRepository } from "../../src/server/collaboration/memory-repository";

const ORIGIN = "https://homing.test";

function rejectingAuthRepository(): AuthRepository {
  return new Proxy(
    {},
    {
      get: () => async () => null,
    },
  ) as AuthRepository;
}

describe("production router composition", () => {
  it("mounts the public kit before the SPA and preserves bearer challenges", async () => {
    const changes = new InMemoryChangeRepository();
    const app = createApp({
      ready: async () => true,
      auth: { repo: rejectingAuthRepository(), origin: ORIGIN },
      agent: {
        changes: { service: new ChangeService(changes) },
        kit: { origin: ORIGIN },
      },
      collaboration: { repository: new InMemoryCollaborationRepository() },
    });

    const kit = await app.request("/agent/pkg/SKILL.md");
    expect(kit.status).toBe(200);
    expect(kit.headers.get("content-type")).toContain("text/markdown");

    const invalidBearer = await app.request(
      "/api/v1/projects/11111111-1111-4111-8111-111111111111/changes",
      { headers: { Authorization: "Bearer invalid" } },
    );
    expect(invalidBearer.status).toBe(401);
    expect(invalidBearer.headers.get("www-authenticate")).toBe(
      `Bearer realm="homing", error="invalid_token", resource_metadata="${ORIGIN}/agent/"`,
    );
    expect(invalidBearer.headers.get("x-request-id")).toBeTruthy();
    expect(await invalidBearer.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
});
