import { describe, expect, it } from "vitest";

import {
  type ChangeRepository,
  ChangeService,
  InMemoryChangeRepository,
} from "../../src/server/agent/changes";
import { createApp } from "../../src/server/app";
import type { AuthRepository } from "../../src/server/auth/repository";
import type { AgentTokenRecord, AuthUser } from "../../src/server/auth/types";
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

function bearerAuthRepository(): AuthRepository {
  const user: AuthUser = {
    id: 7,
    email: "agent@homing.test",
    passwordHash: "unused",
    passwordResetRequired: false,
    isActive: true,
  };
  const token: AgentTokenRecord = {
    id: "22222222-2222-4222-8222-222222222222",
    userId: user.id,
    name: "test-agent",
    tokenPrefix: "homing_test",
    digest: "unused",
    scopes: ["projects:read"],
    projectIds: ["11111111-1111-4111-8111-111111111111"],
    expectedCadenceMinutes: null,
    environmentNote: "",
    exposedToChat: false,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
  };
  return {
    getTokenByDigest: async () => token,
    findUserById: async () => user,
    touchToken: async () => undefined,
  } as unknown as AuthRepository;
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

    for (const path of [
      "/agent-setup",
      "/agent-setup/",
      "/link",
      "/link/",
      "/invitations/raw-token",
      "/settings",
      "/projects/11111111-1111-4111-8111-111111111111",
    ]) {
      const page = await app.request(path);
      expect(page.status, path).toBe(200);
      expect(page.headers.get("content-type"), path).toContain("text/html");
      expect(await page.text(), path).toContain("<!doctype html>");
    }

    const nestedKitMiss = await app.request("/agent-setup/not-allowlisted");
    expect(nestedKitMiss.status).toBe(404);
    expect(await nestedKitMiss.json()).toMatchObject({ error: { code: "not_found" } });
    const redirect = await app.request("/agent-setup/SKILL.md");
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/agent/pkg/SKILL.md");
    const setupHead = await app.request("/agent-setup", { method: "HEAD" });
    expect(setupHead.status).toBe(200);
    expect(setupHead.headers.get("content-type")).toContain("text/html");

    const oversized = await app.request("/api/v1/not-found", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(2 * 1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("private, no-store");
    expect(await oversized.json()).toMatchObject({
      error: { code: "payload_too_large", message: "The request body is too large." },
    });

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

    const unknownApi = await app.request("/api/v1/not-a-real-route");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers.get("cache-control")).toBe("private, no-store");
    expect(unknownApi.headers.get("x-request-id")).toBeTruthy();
    expect(await unknownApi.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("keeps private response headers on an unhandled API error", async () => {
    const explodingRepository: ChangeRepository = {
      feedEpoch: async () => {
        throw new Error("intentional test failure");
      },
      list: async () => [],
    };
    const app = createApp({
      ready: async () => true,
      auth: { repo: bearerAuthRepository(), origin: ORIGIN },
      agent: { changes: { service: new ChangeService(explodingRepository) } },
    });

    const response = await app.request(
      "/api/v1/projects/11111111-1111-4111-8111-111111111111/changes",
      { headers: { Authorization: "Bearer test-token" } },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.json()).toMatchObject({ error: { code: "server_error" } });
  });
});
