import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { digestOpaque } from "../../src/server/auth/crypto";
import { verifyImportedPassword } from "../../src/server/auth/password";
import type { AuthRepository } from "../../src/server/auth/repository";
import { createAuthRouter } from "../../src/server/auth/router";
import type {
  AgentLinkRecord,
  AgentTokenRecord,
  AuthProfile,
  AuthUser,
  CreateAgentLinkInput,
  CreateSessionInput,
  CreateTokenInput,
  InvitationRecord,
  RegisterInvitedUserInput,
  SessionRecord,
} from "../../src/server/auth/types";

const PBKDF2_FIXTURE =
  "pbkdf2_sha256$260000$known-salt$VgacIdGkvu2udMuuojgq5qqZphxnf+nAQ/gA83qSwkI";
// Generated once with Django-compatible Argon2id parameters; the wrapper is Django's format.
const ARGON2_FIXTURE =
  "argon2$argon2id$v=19$m=8192,t=2,p=1$1Jx3YF0EKyZ0vaqZN+vpgtErMtZ9vH5edF2WDr6AJz0$bFMRVvuFxhg1K5hnHwJC/7ayARmxWc9OAyo9jfTd9hM";

describe("imported password verification", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("verifies a fixed Django PBKDF2 fixture and marks it for rehash", async () => {
    vi.stubGlobal("Bun", {
      password: {
        hash: async () => "$argon2id$test-rehash",
        verify: async () => true,
      },
    });
    const encoded = PBKDF2_FIXTURE;
    const result = await verifyImportedPassword("fixture password", encoded);
    expect(result.valid).toBe(true);
    expect(result.rehash).toMatch(/^\$argon2/);
    expect((await verifyImportedPassword("wrong", encoded)).valid).toBe(false);
    expect((await verifyImportedPassword("fixture password", `${PBKDF2_FIXTURE}bad`)).valid).toBe(
      false,
    );
  });

  it("verifies the fixed Django Argon2 wrapper and rejects malformed values", async () => {
    vi.stubGlobal("Bun", {
      password: {
        hash: async () => "$argon2id$test-rehash",
        verify: async (password: string, hash: string) =>
          password === "Correct Horse Battery Staple" &&
          hash === ARGON2_FIXTURE.replace("argon2$", "$"),
      },
    });
    const result = await verifyImportedPassword("Correct Horse Battery Staple", ARGON2_FIXTURE);
    expect(result.valid).toBe(true);
    expect(result.rehash).toMatch(/^\$argon2/);
    expect((await verifyImportedPassword("wrong", ARGON2_FIXTURE)).valid).toBe(false);
    expect(
      (await verifyImportedPassword("Correct Horse Battery Staple", "argon2$not-phc")).valid,
    ).toBe(false);
  });
});

class FakeRepository implements AuthRepository {
  user: AuthUser = {
    id: 7,
    email: "hart@example.test",
    passwordHash: "pbkdf2_sha256$260000$known-salt$YwLk9J6lLqJq7UG4xK8r7VfYqC4H0xQv3I8J0x0J8nA",
    passwordResetRequired: false,
    isActive: true,
  };
  profile: AuthProfile = {
    userId: 7,
    displayName: "Hart",
    timezone: "UTC",
    bio: "",
    personalDetails: {},
    agentPausedUntil: null,
  };
  sessions = new Map<string, SessionRecord>();
  tokens = new Map<string, AgentTokenRecord>();
  links = new Map<string, AgentLinkRecord>();
  throttles = new Map<string, { count: number; startedAt: Date }>();
  invitation: InvitationRecord = {
    id: "8316deaf-46de-4dcf-9755-d0be396ec623",
    projectId: "b3f39d6c-72e8-43f1-aec5-efb2b3f069df",
    email: "new@example.test",
    role: "viewer",
    projectName: "September search",
    inviterName: "Hart",
    expiresAt: new Date("2026-08-21T12:00:00Z"),
  };
  invitationDigest = digestOpaque("invite-secret");
  invitationAccepted = false;
  invitationMembershipCreated = false;

  async findUserByEmail(email: string) {
    return email === this.user.email ? this.user : null;
  }
  async findUserById(id: number) {
    return id === this.user.id ? this.user : null;
  }
  async findProfileByUserId(id: number) {
    return id === this.user.id ? this.profile : null;
  }
  async updateProfile(userId: number, patch: Partial<Omit<AuthProfile, "userId">>) {
    if (userId !== this.user.id) return null;
    Object.assign(this.profile, patch);
    return this.profile;
  }
  async getSession(digest: string) {
    return this.sessions.get(digest) ?? null;
  }
  async createSession(input: CreateSessionInput) {
    this.sessions.set(input.digest, { ...input });
  }
  async completeLogin(
    oldDigest: string | null,
    input: CreateSessionInput,
    userId: number,
    passwordHash?: string,
  ) {
    if (oldDigest) this.sessions.delete(oldDigest);
    this.sessions.set(input.digest, { ...input });
    if (passwordHash && userId === this.user.id) this.user.passwordHash = passwordHash;
  }
  async deleteSession(digest: string) {
    this.sessions.delete(digest);
  }
  async updateSessionCsrf(digest: string, csrfDigest: string) {
    const session = this.sessions.get(digest);
    if (!session) return false;
    session.csrfDigest = csrfDigest;
    return true;
  }
  async findPendingInvitation(digest: string, now: Date) {
    return digest === this.invitationDigest &&
      this.invitation.expiresAt > now &&
      !this.invitationAccepted
      ? this.invitation
      : null;
  }
  async registerInvitedUser(input: RegisterInvitedUserInput) {
    if (
      input.invitationDigest !== this.invitationDigest ||
      input.email !== this.invitation.email ||
      this.invitationAccepted
    ) {
      return null;
    }
    this.user = {
      id: 8,
      email: input.email,
      passwordHash: input.passwordHash,
      passwordResetRequired: false,
      isActive: true,
    };
    this.profile = {
      ...this.profile,
      userId: 8,
      displayName: input.displayName,
    };
    this.invitationMembershipCreated = true;
    this.invitationAccepted = true;
    return { user: this.user, projectId: this.invitation.projectId };
  }
  async acceptInvitation(digest: string, userId: number, now: Date) {
    if (
      digest !== this.invitationDigest ||
      userId !== this.user.id ||
      this.user.email !== this.invitation.email ||
      this.invitation.expiresAt <= now ||
      this.invitationAccepted
    ) {
      return null;
    }
    this.invitationAccepted = true;
    return this.invitation.projectId;
  }
  async consumeThrottle(keyDigests: string[], now: Date, limit: number, windowMs: number) {
    let retryAfter = 0;
    let blocked = false;
    for (const digest of keyDigests) {
      const existing = this.throttles.get(digest);
      const bucket =
        !existing || now.getTime() - existing.startedAt.getTime() >= windowMs
          ? { count: 0, startedAt: now }
          : existing;
      if (bucket.count >= limit) {
        blocked = true;
        retryAfter = Math.max(
          retryAfter,
          Math.ceil((bucket.startedAt.getTime() + windowMs - now.getTime()) / 1000),
        );
      } else {
        bucket.count += 1;
      }
      this.throttles.set(digest, bucket);
    }
    return { blocked, retryAfter };
  }
  async resetThrottle(keyDigests: string[], now: Date) {
    for (const digest of keyDigests) this.throttles.set(digest, { count: 0, startedAt: now });
  }
  async getTokenByDigest(digest: string) {
    return [...this.tokens.values()].find((token) => token.digest === digest) ?? null;
  }
  async getTokenById(userId: number, id: string) {
    const token = this.tokens.get(id);
    return token?.userId === userId ? token : null;
  }
  async listTokens(userId: number) {
    return [...this.tokens.values()].filter((token) => token.userId === userId);
  }
  async createToken(input: CreateTokenInput) {
    const token: AgentTokenRecord = {
      ...input,
      createdAt: input.createdAt ?? new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.tokens.set(token.id, token);
    return token;
  }
  async revokeToken(userId: number, id: string, at: Date) {
    const token = await this.getTokenById(userId, id);
    if (!token) return false;
    token.revokedAt = at;
    return true;
  }
  async touchToken(id: string, at: Date) {
    const token = this.tokens.get(id);
    if (token) token.lastUsedAt = at;
  }
  async createAgentLink(input: CreateAgentLinkInput) {
    const link: AgentLinkRecord = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      status: "pending",
      pollCount: 0,
      lastPolledAt: null,
      approvedById: null,
      issuedTokenId: null,
    };
    this.links.set(link.id, link);
    return link;
  }
  async getAgentLinkByDigest(digest: string) {
    return [...this.links.values()].find((link) => link.deviceCodeDigest === digest) ?? null;
  }
  async pollAgentLink(digest: string, now: Date, maxPolls: number) {
    const link = await this.getAgentLinkByDigest(digest);
    if (!link || link.status === "denied" || link.status === "consumed") {
      return { outcome: "access_denied" as const, link };
    }
    if (link.status === "expired") return { outcome: "expired_token" as const, link };
    const pollCount = link.pollCount + 1;
    if (
      link.lastPolledAt &&
      now.getTime() - link.lastPolledAt.getTime() < link.intervalSeconds * 1_000
    ) {
      Object.assign(link, { pollCount, lastPolledAt: now });
      return { outcome: "slow_down" as const, link };
    }
    Object.assign(link, { pollCount, lastPolledAt: now });
    if (link.expiresAt <= now || pollCount > maxPolls) {
      link.status = "expired";
      return { outcome: "expired_token" as const, link };
    }
    return {
      outcome:
        link.status === "approved" ? ("approved" as const) : ("authorization_pending" as const),
      link,
    };
  }
  async getPendingAgentLinkByCode(userCode: string, now: Date) {
    return (
      [...this.links.values()].find(
        (link) => link.userCode === userCode && link.status === "pending" && link.expiresAt > now,
      ) ?? null
    );
  }
  async updateAgentLink(id: string, patch: Partial<AgentLinkRecord>) {
    const link = this.links.get(id);
    if (link) Object.assign(link, patch);
  }
  async consumeApprovedAgentLink(linkId: string, userId: number, input: CreateTokenInput) {
    const link = this.links.get(linkId);
    if (link?.status !== "approved" || link.approvedById !== userId) return null;
    const token = await this.createToken(input);
    link.status = "consumed";
    link.issuedTokenId = token.id;
    return token;
  }
  async decideAgentLink(
    userCode: string,
    userId: number,
    decision: "approved" | "denied",
    _at?: Date,
  ) {
    const link = [...this.links.values()].find(
      (candidate) => candidate.userCode === userCode && candidate.status === "pending",
    );
    if (!link) return false;
    link.status = decision;
    link.approvedById = userId;
    return true;
  }
}

describe("auth router", () => {
  it("mounts under the versioned app and preserves request ids", async () => {
    const app = createApp({
      ready: async () => true,
      auth: { repo: new FakeRepository(), origin: "https://example.test" },
    });
    const response = await app.request("https://example.test/api/v1/csrf", {
      headers: { "X-Request-ID": "auth-mount-test" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toBe("auth-mount-test");
  });

  it("issues stateless, expiring CSRF bootstrap cookies without database writes", async () => {
    const repo = new FakeRepository();
    let now = new Date("2026-08-20T12:00:00Z");
    const router = createAuthRouter({
      repo,
      origin: "https://example.test",
      throttleKey: "test-auth-hmac-key-at-least-32-bytes",
      now: () => now,
    });
    const csrf = await router.request("https://example.test/csrf");
    const csrfToken = ((await csrf.json()) as { csrf_token: string }).csrf_token;
    const cookie = csrf.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(repo.sessions.size).toBe(0);

    now = new Date("2026-08-20T12:16:00Z");
    const expired = await router.request("https://example.test/session", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://example.test",
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "hart@example.test", password: "wrong" }),
    });
    expect(expired.status).toBe(403);
    expect((await expired.json()).error.code).toBe("csrf_failed");
    expect(repo.sessions.size).toBe(0);
  });

  it("checks the IP throttle before allocating arbitrary email buckets", async () => {
    const repo = new FakeRepository();
    const router = createAuthRouter({
      repo,
      origin: "https://example.test",
      clientAddress: () => "192.0.2.10",
      now: () => new Date("2026-08-20T12:00:00Z"),
    });
    const csrf = await router.request("https://example.test/csrf");
    const csrfToken = ((await csrf.json()) as { csrf_token: string }).csrf_token;
    const cookie = csrf.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await router.request("https://example.test/session", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://example.test",
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: `unknown-${index}@example.test`,
          password: "wrong password",
        }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(repo.throttles.size).toBe(6);
  });

  it("binds CSRF to the exact Origin and rotates the session on login", async () => {
    const repo = new FakeRepository();
    const router = createAuthRouter({
      repo,
      origin: "https://example.test",
      now: () => new Date("2026-08-20T12:00:00Z"),
    });
    const csrf = await router.request("https://example.test/csrf");
    expect(csrf.status).toBe(200);
    const csrfToken = ((await csrf.json()) as { csrf_token: string }).csrf_token;
    const setCookie = csrf.headers.get("set-cookie");
    if (!setCookie) throw new Error("csrf response did not set a session cookie");
    const cookie = setCookie.split(";", 1)[0] ?? "";
    const blocked = await router.request("https://example.test/session", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://evil.test",
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "hart@example.test", password: "wrong" }),
    });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe("csrf_failed");
  });

  it("rehashes an imported password while consuming the anonymous session", async () => {
    vi.stubGlobal("Bun", {
      password: {
        hash: async () => "$argon2id$rehash-after-login",
        verify: async () => false,
      },
    });
    const repo = new FakeRepository();
    repo.user.passwordHash = PBKDF2_FIXTURE; // gitleaks:allow -- fixed Django test fixture
    const router = createAuthRouter({
      repo,
      origin: "https://example.test",
      now: () => new Date("2026-08-20T12:00:00Z"),
    });
    const csrf = await router.request("https://example.test/csrf");
    const csrfToken = ((await csrf.json()) as { csrf_token: string }).csrf_token;
    const cookie = csrf.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const oldRaw = cookie.split("=")[1] ?? "";
    const response = await router.request("https://example.test/session", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "https://example.test",
        "X-CSRF-Token": csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: repo.user.email,
        password: "fixture password",
      }),
    });
    expect(response.status).toBe(200);
    expect(repo.user.passwordHash).toBe("$argon2id$rehash-after-login");
    expect(repo.sessions.has(digestOpaque(oldRaw))).toBe(false);
    expect(response.headers.get("set-cookie")).not.toContain(oldRaw);
  });

  it("registers only the invited email, rotates the session, and accepts once", async () => {
    vi.stubGlobal("Bun", {
      password: {
        hash: async () => "$argon2id$registered-password",
        verify: async () => false,
      },
    });
    const repo = new FakeRepository();
    const router = createAuthRouter({
      repo,
      origin: "https://example.test",
      now: () => new Date("2026-08-20T12:00:00Z"),
    });
    const csrf = await router.request("https://example.test/csrf");
    const csrfToken = ((await csrf.json()) as { csrf_token: string }).csrf_token;
    const initialCookie = csrf.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const wrongRecipient = await router.request(
      "https://example.test/invitations/invite-secret/register",
      {
        method: "POST",
        headers: {
          Cookie: initialCookie,
          Origin: "https://example.test",
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "other@example.test",
          display_name: "Other",
          password: "a sufficiently long password",
        }),
      },
    );
    expect(wrongRecipient.status).toBe(422);
    expect(repo.user.id).toBe(7);
    expect(repo.invitationMembershipCreated).toBe(false);
    expect(repo.invitationAccepted).toBe(false);

    const registered = await router.request(
      "https://example.test/invitations/invite-secret/register",
      {
        method: "POST",
        headers: {
          Cookie: initialCookie,
          Origin: "https://example.test",
          "X-CSRF-Token": csrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "new@example.test",
          display_name: "New teammate",
          password: "a sufficiently long password",
        }),
      },
    );
    expect(registered.status).toBe(201);
    const registration = (await registered.json()) as { csrf_token: string; project_id: string };
    expect(registration.project_id).toBe(repo.invitation.projectId);
    expect(repo.invitationMembershipCreated).toBe(true);
    expect(repo.invitationAccepted).toBe(true);
    const authenticatedCookie = registered.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const pausedUntil = "2026-08-21T18:00:00.000Z";
    const profile = await router.request("https://example.test/me/profile", {
      method: "PATCH",
      headers: {
        Cookie: authenticatedCookie,
        Origin: "https://example.test",
        "X-CSRF-Token": registration.csrf_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ display_name: "New name", agent_paused_until: pausedUntil }),
    });
    expect(profile.status).toBe(200);
    expect((await profile.json()).agent_paused_until).toBe(pausedUntil);
    const introspection = await router.request("https://example.test/me/token", {
      headers: { Cookie: authenticatedCookie },
    });
    expect((await introspection.json()).agent_paused_until).toBe(pausedUntil);
    const replay = await router.request("https://example.test/invitations/invite-secret/accept", {
      method: "POST",
      headers: {
        Cookie: authenticatedCookie,
        Origin: "https://example.test",
        "X-CSRF-Token": registration.csrf_token,
      },
    });
    expect(replay.status).toBe(404);
  });

  it("lets the exact existing recipient accept a pending invitation", async () => {
    const repo = new FakeRepository();
    repo.invitation.email = repo.user.email;
    const rawSession = "authenticated-session";
    const rawCsrf = "authenticated-csrf";
    repo.sessions.set(digestOpaque(rawSession), {
      digest: digestOpaque(rawSession),
      userId: repo.user.id,
      csrfDigest: digestOpaque(rawCsrf),
      expiresAt: new Date("2026-08-21T12:00:00Z"),
    });
    const router = createAuthRouter({
      repo,
      origin: "https://example.test",
      now: () => new Date("2026-08-20T12:00:00Z"),
    });
    const response = await router.request("https://example.test/invitations/invite-secret/accept", {
      method: "POST",
      headers: {
        Cookie: `__Host-homing_session=${rawSession}`,
        Origin: "https://example.test",
        "X-CSRF-Token": rawCsrf,
      },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).project_id).toBe(repo.invitation.projectId);
    expect(repo.invitationAccepted).toBe(true);
  });

  it("does not fall back to a browser session for an invalid bearer header", async () => {
    const repo = new FakeRepository();
    const router = createAuthRouter({ repo, origin: "https://example.test" });
    const response = await router.request("https://example.test/me", {
      headers: { Authorization: "Basic not-a-bearer", Cookie: "__Host-homing_session=anything" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("enforces profile:read for bearer profile access", async () => {
    const repo = new FakeRepository();
    const raw = "project-only-token";
    await repo.createToken({
      id: "c80e49e9-5748-47a5-ad54-2c5d6532333d",
      userId: repo.user.id,
      name: "project only",
      tokenPrefix: raw.slice(0, 12),
      digest: digestOpaque(raw),
      scopes: ["projects:read"],
      projectIds: [],
      expectedCadenceMinutes: null,
      environmentNote: "",
      exposedToChat: false,
      expiresAt: new Date("2027-08-20T12:00:00Z"),
    });
    const router = createAuthRouter({
      repo,
      origin: "https://example.test",
      now: () => new Date("2026-08-20T12:00:00Z"),
    });
    const response = await router.request("https://example.test/me/profile", {
      headers: { Authorization: `Bearer ${raw}` },
    });
    expect(response.status).toBe(403);
  });

  it("returns a paired token once and withholds leads:destroy", async () => {
    const repo = new FakeRepository();
    const router = createAuthRouter({ repo, origin: "https://example.test" });
    const start = await router.request("https://example.test/agent-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_label: "test agent" }),
    });
    expect(start.status).toBe(201);
    const started = (await start.json()) as { device_code: string; user_code: string };
    const rawSession = "pairing-session";
    const rawCsrf = "pairing-csrf";
    repo.sessions.set(digestOpaque(rawSession), {
      digest: digestOpaque(rawSession),
      userId: repo.user.id,
      csrfDigest: digestOpaque(rawCsrf),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const approved = await router.request(
      `https://example.test/auth/agent-links/${started.user_code}`,
      {
        method: "POST",
        headers: {
          Cookie: `__Host-homing_session=${rawSession}`,
          Origin: "https://example.test",
          "X-CSRF-Token": rawCsrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "approve" }),
      },
    );
    expect(approved.status).toBe(200);
    const poll = await router.request("https://example.test/agent-link/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: started.device_code }),
    });
    expect(poll.status).toBe(200);
    expect((await poll.json()).scopes).not.toContain("leads:destroy");
  });
});
