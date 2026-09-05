import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { describe, expect, test } from "vitest";
import { sha256Hex } from "../../src/server/agent/v2/canonical";
import type { V2Repository } from "../../src/server/agent/v2/repository";
import { createV2Router } from "../../src/server/agent/v2/router";
import type { RequiredEvidenceKey } from "../../src/server/agent/v2/schemas";
import { createApp } from "../../src/server/app";
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
const hash = sha256Hex(new TextEncoder().encode('{"version":1}'));

function build(profileOverride: AuthProfile = profile) {
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
        configSha256: hash,
        prompt: "Find a home",
        criteria: {},
        acquisitionBasis: { locations: ["Brooklyn"] },
        requiredEvidence: ["location", "price", "availability", "housing_type"],
        sourceQueries: [
          {
            id: queryId,
            revision: 1,
            adapter: "zumper-com",
            status: "ready",
            sha256: hash,
            query: { url: "https://www.zumper.com/homes/brooklyn" },
          },
        ],
        pausedUntil: null,
        latestRun: null,
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
    findProfileByUserId: async () => profileOverride,
    touchToken: async () => {},
    revokeToken: async () => true,
  } as unknown as AuthRepository;
  const router = createV2Router({
    repository,
    auth: { repo: auth, origin: "https://homing.test" },
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  return { router, calls, repository, auth };
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

  test("does not report an expired pause as active", async () => {
    const { router } = build({
      ...profile,
      agentPausedUntil: new Date("2026-08-28T00:00:00.000Z"),
    });
    const projects = await router.request("/agent/projects", { headers: authHeader });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toMatchObject({ agent_paused_until: null, paused_until: null });
    const token = await router.request("/me/token", { headers: authHeader });
    expect(token.status).toBe(200);
    expect(await token.json()).toMatchObject({ agent_paused_until: null });
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
        acquisition_basis: {
          locations: ["Brooklyn"],
          min_price_minor: null,
          max_price_minor: 250000,
          housing_types: ["entire"],
        },
        source_queries: [
          { adapter: "zumper-com", query: { url: "https://www.zumper.com/homes/brooklyn" } },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const sourceQueries = calls.config?.sourceQueries as Array<Record<string, unknown>>;
    expect(sourceQueries).toHaveLength(1);
    expect(sourceQueries?.[0]?.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("accepts the reviewed client config shape and uses the server project brief", async () => {
    const { router, calls } = build();
    const response = await router.request(`/projects/${projectId}/config-revisions`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_revision: 1,
        required_evidence: ["location", "price", "availability", "housing_type"],
        acquisition_basis: {
          locations: ["Brooklyn"],
          min_price_minor: null,
          max_price_minor: 250000,
          housing_types: ["entire"],
        },
        source_queries: [
          { adapter: "zumper-com", query: { url: "https://www.zumper.com/homes/brooklyn" } },
        ],
      }),
    });
    expect(response.status).toBe(201);
    expect(calls.config).not.toHaveProperty("prompt");
    expect(calls.config).not.toHaveProperty("criteria");
  });

  test.each([
    ["empty required evidence", { required_evidence: [] }],
    ["duplicate required evidence", { required_evidence: ["location", "location"] }],
    [
      "wrong adapter host",
      {
        source_queries: [
          { adapter: "zumper-com", query: { url: "https://streeteasy.com/for-rent" } },
        ],
      },
    ],
    [
      "insecure source URL",
      {
        source_queries: [{ adapter: "zumper-com", query: { url: "http://zumper.com/for-rent" } }],
      },
    ],
    [
      "too many queries for one adapter",
      {
        source_queries: Array.from({ length: 5 }, (_, index) => ({
          adapter: "zumper-com",
          query: { url: `https://zumper.com/for-rent/${index}` },
        })),
      },
    ],
  ])("rejects invalid HTTP config: %s", async (_name, overrides) => {
    const { router } = build();
    const response = await router.request(`/projects/${projectId}/config-revisions`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        required_evidence: ["location", "price", "availability", "housing_type"],
        acquisition_basis: {
          locations: ["Brooklyn"],
          min_price_minor: null,
          max_price_minor: null,
          housing_types: [],
        },
        source_queries: [{ adapter: "zumper-com", query: { url: "https://zumper.com/for-rent" } }],
        ...overrides,
      }),
    });
    expect(response.status).toBe(422);
  });

  test.each([
    ["missing field", { locations: ["Brooklyn"], min_price_minor: null, max_price_minor: 250000 }],
    [
      "unknown field",
      {
        locations: ["Brooklyn"],
        min_price_minor: null,
        max_price_minor: 250000,
        housing_types: [],
        neighborhood: "Brooklyn",
      },
    ],
    [
      "empty locations",
      { locations: [], min_price_minor: null, max_price_minor: 250000, housing_types: [] },
    ],
    [
      "inverted price range",
      {
        locations: ["Brooklyn"],
        min_price_minor: 300000,
        max_price_minor: 250000,
        housing_types: [],
      },
    ],
    [
      "duplicate housing type",
      {
        locations: ["Brooklyn"],
        min_price_minor: null,
        max_price_minor: null,
        housing_types: ["entire", "entire"],
      },
    ],
  ])("rejects invalid acquisition basis: %s", async (_name, acquisition_basis) => {
    const { router } = build();
    const response = await router.request(`/projects/${projectId}/config-revisions`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        required_evidence: ["location", "price", "availability", "housing_type"],
        acquisition_basis,
        source_queries: [{ adapter: "zumper-com", query: { url: "https://zumper.com/for-rent" } }],
      }),
    });
    expect(response.status).toBe(422);
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
    const nonterminal = await router.request(`/agent-runs/${runId}`, {
      method: "PATCH",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "started",
        phase: "snapshot",
        queries: [{ source_query_revision_id: queryId, status: "pending" }],
        counts: {
          source_queries_total: 1,
          source_queries_attempted: 0,
          source_queries_completed: 0,
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
    expect(nonterminal.status).toBe(422);
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

  test.each([
    ["unsupported key", ["not-an-evidence-key"]],
    ["duplicate key", ["location", "location"]],
  ])("rejects invalid delivery unknowns: %s", async (_name, unknowns) => {
    const { router } = build();
    const response = await router.request(
      `/projects/${projectId}/leads/create-or-return-existing`,
      {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt_revision_id: 12,
          facts_hash: hash,
          disposition: "kept",
          reason: "fits",
          unknowns,
          lead: {
            source: "zumper-com",
            source_listing_id: "invalid-unknowns",
            canonical_url: "https://example.test/invalid-unknowns",
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
    expect(response.status).toBe(422);
  });
});

describe("reviewed Python client wire contract", () => {
  test("can drive the Hono transport through snapshot, run, delivery, and disconnect", async () => {
    const { repository, auth } = build();
    const app = createApp({
      auth: { repo: auth, origin: "https://homing.test" },
      v2: { repository, now: () => new Date("2026-08-29T00:00:00.000Z") },
      spaIndex: () => new Response("spa"),
    });
    const packagePath = `${process.cwd()}/agentkit/package`;
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const init: RequestInit = {
          headers: request.headers as HeadersInit,
          ...(request.method ? { method: request.method } : {}),
          ...(request.method === "GET" || request.method === "HEAD" || !body ? {} : { body }),
        };
        const result = await app.fetch(new Request(url, init));
        response.statusCode = result.status;
        result.headers.forEach((value, name) => {
          response.setHeader(name, value);
        });
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const script = `
import json, os, sys, urllib.error, urllib.request, urllib.parse, uuid
sys.path.insert(0, sys.argv[1])
from homing import HomingClient, Response

base = sys.argv[2]
def transport(method, url, body, headers):
    parsed = urllib.parse.urlsplit(url)
    request = urllib.request.Request(base + parsed.path, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=5) as result:
            return Response(result.status, result.read(), dict(result.headers.items()))
    except urllib.error.HTTPError as error:
        return Response(error.code, error.read(), dict(error.headers.items()))

client = HomingClient("https://homing.test", lambda: "v2-secret", transport=transport)
projects = client.projects()
assert len(projects) == 1
project = projects[0]
project_id = project["project_id"]
created_config = client.create_config(project_id, {"expected_revision": project["current_config_revision"], "required_evidence": ["location", "price", "availability", "housing_type"], "acquisition_basis": {"locations": ["Brooklyn"], "min_price_minor": None, "max_price_minor": None, "housing_types": []}, "source_queries": [{"adapter": "zumper-com", "query": {"url": "https://www.zumper.com/homes/brooklyn"}}]})
assert created_config["config_status"] in {"complete", "needs_review"}
config = client.config_revision(project_id, str(project["current_config_revision"]), project["config_sha256"])
query = project["source_queries"][0]
source = client.source_revision(project_id, str(query["id"]), query["sha256"])
assert config["version"] == 1 and source["version"] == 1
snapshot = [{"project_id": project_id, "config_revision": project["current_config_revision"], "config_sha256": project["config_sha256"], "source_queries": [{"id": query["id"], "revision": query["revision"], "sha256": query["sha256"]}]}]
run_id = client.create_run(str(uuid.uuid4()), snapshot)
client.finish_run(run_id, {"status": "completed", "phase": "finish", "queries": [{"source_query_revision_id": query["id"], "status": "completed"}], "counts": {"source_queries_total": 1, "source_queries_attempted": 1, "source_queries_completed": 1, "candidates_observed": 0, "candidates_evaluated": 0, "candidates_kept": 0, "candidates_insufficient": 0, "deliveries_acknowledged": 0, "deliveries_pending": 0}, "failure": None})
delivery = client.deliver(project_id, {"prompt_revision": project["current_config_revision"], "facts_hash": "${"a".repeat(64)}", "lead": {"source": "zumper-com", "source_listing_id": "python-1", "url": "https://example.test/python-1", "title": "Home", "summary": "", "location": "Brooklyn", "price_amount": "2500.00", "price_display": "$2,500", "availability": "now", "housing_type": "entire"}}, "delivery-key")
assert delivery.get("outcome") in {"created", "existing"}
assert isinstance(client.finalize_setup(), dict)
assert str(uuid.UUID(client.connection_id()))
client.disconnect()
print("ok")
`;
    try {
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn("python3", ["-c", script, packagePath, `http://127.0.0.1:${port}`]);
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on("close", (status) => resolve({ status, stdout, stderr }));
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("ok");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
