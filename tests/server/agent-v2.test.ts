import { describe, expect, test } from "vitest";
import type { V2Repository } from "../../src/server/agent/v2/repository";
import { createV2Router } from "../../src/server/agent/v2/router";
import type { RequiredEvidenceKey } from "../../src/server/agent/v2/schemas";
import { digestOpaque } from "../../src/server/auth/crypto";
import type { AuthRepository } from "../../src/server/auth/repository";
import type { AgentTokenRecord, AuthProfile, AuthUser } from "../../src/server/auth/types";

const user: AuthUser = {
  id: 7,
  email: "hart@example.test",
  passwordHash: "unused",
  passwordResetRequired: false,
  isActive: true,
};
const profile: AuthProfile = {
  userId: user.id,
  displayName: "Hart",
  timezone: "UTC",
  bio: "",
  personalDetails: {},
  agentPausedUntil: null,
};
const token: AgentTokenRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: user.id,
  name: "v2 test",
  tokenPrefix: "v2-test",
  digest: digestOpaque("v2-secret"),
  scopes: [
    "agent-config:read",
    "source-config:write",
    "agent-runs:write",
    "agent-deliveries:write",
    "connection:self",
  ],
  projectIds: [],
  expectedCadenceMinutes: null,
  environmentNote: "",
  exposedToChat: false,
  sourceWriteExpiresAt: new Date("2026-09-01T00:30:00.000Z"),
  expiresAt: new Date("2026-12-01T00:00:00.000Z"),
  revokedAt: null,
  lastUsedAt: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

const projectId = "22222222-2222-4222-8222-222222222222";
const queryId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const hash = "a".repeat(64);

function build() {
  const configBytes = new TextEncoder().encode('{"version":1}');
  const calls: { config?: Record<string, unknown>; report?: unknown; delivery?: unknown } = {};
  const config = {
    id: 12,
    projectId,
    revision: 1,
    status: "complete" as const,
    canonicalBytes: configBytes,
    canonicalSha256: hash,
    requiredEvidence: [
      "location",
      "price",
      "availability",
      "housing_type",
    ] as RequiredEvidenceKey[],
    sourceQueryIds: [queryId],
  };
  const repository: V2Repository = {
    listProjects: async () => [
      {
        id: projectId,
        name: "Home",
        slug: "home",
        configStatus: "ready",
        configRevision: 1,
        configRevisionId: 12,
        pausedUntil: null,
      },
    ],
    getConfigRevision: async () => config,
    getSourceQueryRevision: async () => ({
      id: queryId,
      projectId,
      adapter: "zumper-com",
      revision: 1,
      status: "ready",
      canonicalBytes: configBytes,
      canonicalSha256: hash,
      acquisitionBasisHash: hash,
    }),
    createConfigRevision: async (input) => {
      calls.config = input as unknown as Record<string, unknown>;
      return config;
    },
    createRun: async (input) => ({
      replayed: false,
      run: {
        id: runId,
        invocationId: input.invocationId,
        userId: user.id,
        tokenId: token.id,
        agentLabel: input.agentLabel,
        status: "started",
        phase: "snapshot",
        projects: input.projects,
        report: null,
      },
    }),
    finalizeRun: async (_userId, _tokenId, _runId, report) => {
      calls.report = report;
      return {
        replayed: false,
        run: {
          id: runId,
          invocationId: "55555555-5555-4555-8555-555555555555",
          userId: user.id,
          tokenId: token.id,
          agentLabel: "runner",
          status: report.status,
          phase: report.phase,
          projects: [],
          report,
        },
      };
    },
    deliver: async (input) => {
      calls.delivery = input;
      return {
        status: "created",
        leadId: "66666666-6666-4666-8666-666666666666",
        observationId: "77777777-7777-4777-8777-777777777777",
      };
    },
    finalizeSourceWrite: async () => ({
      ...token,
      scopes: token.scopes.filter((scope) => scope !== "source-config:write"),
      sourceWriteExpiresAt: null,
    }),
    grantSourceWrite: async () => token,
  };
  const auth = {
    getTokenByDigest: async (digest: string) => (digest === token.digest ? token : null),
    findUserById: async (id: number) => (id === user.id ? user : null),
    findProfileByUserId: async () => profile,
    touchToken: async () => {},
  } as unknown as AuthRepository;
  const router = createV2Router({
    repository,
    auth: { repo: auth, origin: "https://homing.test" },
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  return { router, calls };
}

const authHeader = { Authorization: "Bearer v2-secret" };

describe("v2 server contract", () => {
  test("serves immutable bytes with a strong ETag and conditional reads", async () => {
    const { router } = build();
    const first = await router.request(`/projects/${projectId}/config-revisions/1`, {
      headers: authHeader,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("ETag")).toBe(`"sha256-${hash}"`);
    expect(await first.text()).toBe('{"version":1}');
    const second = await router.request(`/projects/${projectId}/config-revisions/1`, {
      headers: { ...authHeader, "If-None-Match": `"sha256-${hash}"` },
    });
    expect(second.status).toBe(304);
  });

  test("canonicalizes attended config input before repository persistence", async () => {
    const { router, calls } = build();
    const response = await router.request(`/projects/${projectId}/config-revisions`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_revision: null,
        prompt: "Find a home",
        criteria: { max_price: 2500 },
        required_evidence: ["location", "price", "availability", "housing_type"],
        acquisition_basis: { location: "Brooklyn" },
        source_queries: [
          { adapter: "zumper-com", query: { max_price: 2500, location: "Brooklyn" } },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const sourceQueries = calls.config?.sourceQueries as Array<Record<string, unknown>>;
    expect(sourceQueries).toHaveLength(1);
    expect(sourceQueries?.[0]?.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("validates terminal run outcomes and records additive delivery", async () => {
    const { router, calls } = build();
    const run = await router.request("/agent-runs", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        invocation_id: "55555555-5555-4555-8555-555555555555",
        agent_label: "runner",
        projects: [
          {
            project_id: projectId,
            prompt_revision_id: 12,
            prompt_revision: 1,
            canonical_sha256: hash,
            queries: [
              {
                source_query_revision_id: queryId,
                source_query_revision: 1,
                canonical_sha256: hash,
              },
            ],
          },
        ],
      }),
    });
    expect(run.status).toBe(201);
    const finalized = await router.request(`/agent-runs/${runId}`, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        phase: "finish",
        queries: [{ source_query_revision_id: queryId, status: "completed" }],
        counts: {
          source_queries_total: 1,
          source_queries_attempted: 1,
          source_queries_completed: 1,
          candidates_observed: 0,
          candidates_evaluated: 0,
          candidates_kept: 0,
          candidates_insufficient: 0,
          deliveries_acknowledged: 0,
          deliveries_pending: 0,
        },
        failure: null,
      }),
    });
    expect(finalized.status).toBe(200);
    expect(calls.report).toMatchObject({ status: "completed" });
    const delivery = await router.request(
      `/projects/${projectId}/leads/create-or-return-existing`,
      {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt_revision_id: 12,
          facts_hash: hash,
          disposition: "kept",
          reason: "fits",
          unknowns: [],
          lead: {
            source: "zumper-com",
            source_listing_id: "listing-1",
            canonical_url: "https://example.test/listing-1",
            title: "Home",
            summary: "",
            location: "Brooklyn",
            price_display: "$2,500",
            price_amount: "2500.00",
            price_currency: "USD",
            availability: "now",
            housing_type: "entire",
            listed_at: null,
            attributes: {},
            verification_notes: "",
          },
        }),
      },
    );
    expect(delivery.status).toBe(201);
    expect(calls.delivery).toBeDefined();
  });
});
