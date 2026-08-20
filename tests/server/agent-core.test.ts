import { unzipSync } from "fflate";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { ChangeService, InMemoryChangeRepository } from "../../src/server/agent/changes";
import { AgentCoreError } from "../../src/server/agent/errors";
import { buildKitPackage } from "../../src/server/agent/kit";
import { createAgentCoreRouter } from "../../src/server/agent/router";
import {
  type AgentPrincipal,
  InMemoryRunRepository,
  RunService,
} from "../../src/server/agent/runs";
import {
  InMemorySourcePlanRepository,
  SourcePlanService,
} from "../../src/server/agent/source-plans";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const principal: AgentPrincipal = {
  userId: 7,
  tokenId: "22222222-2222-4222-8222-222222222222",
  scopes: ["projects:read", "runs:write"],
  projectIds: [PROJECT_ID],
};

function testApp(options: {
  runs?: RunService;
  changes?: ChangeService;
  sourcePlans?: SourcePlanService;
  kit?: ReturnType<typeof buildKitPackage>;
}) {
  const app = new Hono();
  app.route(
    "/",
    createAgentCoreRouter({
      principal: () => principal,
      ...(options.runs ? { runs: { service: options.runs } } : {}),
      ...(options.changes ? { changes: { service: options.changes } } : {}),
      ...(options.sourcePlans
        ? {
            sourcePlans: {
              service: options.sourcePlans,
              origin: "https://homing.test/path-is-ignored",
            },
          }
        : {}),
      ...(options.kit ? { kit: { package: options.kit } } : {}),
    }),
  );
  app.onError((error, context) => {
    if (error instanceof AgentCoreError) {
      return context.json(
        { error: { code: error.code, message: error.message, fields: error.fields } },
        error.status,
      );
    }
    throw error;
  });
  return app;
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("agent run lifecycle", () => {
  let repository: InMemoryRunRepository;
  let app: ReturnType<typeof testApp>;

  beforeEach(() => {
    repository = new InMemoryRunRepository();
    repository.seedProject({
      id: PROJECT_ID,
      promptRevision: 4,
      promptSnapshot: "Find the current housing fit.",
      criteriaSnapshot: { max_price: 3_000 },
    });
    app = testApp({ runs: new RunService(repository) });
  });

  async function createRun(key: string, label = "homing/cloud-a") {
    return app.request(`/api/v1/projects/${PROJECT_ID}/search-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({ agent_label: label, input_cursor: "epochabc1:0" }),
    });
  }

  it("requires a nonempty label and replays create with the original 201 response", async () => {
    const missing = await createRun("missing-label", "");
    expect(missing.status).toBe(422);

    const first = await createRun("create-1");
    const replay = await createRun("create-1");
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());

    const changed = await createRun("create-1", "homing/cloud-b");
    expect(changed.status).toBe(409);
    expect(await body(changed)).toMatchObject({ error: { code: "idempotency_key_reused" } });
  });

  it("uses stable keyset run pagination", async () => {
    const ids: string[] = [];
    for (const [key, label] of [
      ["page-a", "homing/cloud-a"],
      ["page-b", "homing/cloud-b"],
      ["page-c", "homing/cloud-c"],
    ] as const) {
      ids.push(String((await body(await createRun(key, label))).id));
    }
    const first = await body(
      await app.request(`/api/v1/projects/${PROJECT_ID}/search-runs?limit=1`),
    );
    expect((first.items as unknown[]).length).toBe(1);
    expect(String(first.next_cursor)).not.toBe("");
    const second = await body(
      await app.request(
        `/api/v1/projects/${PROJECT_ID}/search-runs?limit=2&cursor=${encodeURIComponent(String(first.next_cursor))}`,
      ),
    );
    const seen = [
      ...(first.items as Record<string, unknown>[]),
      ...(second.items as Record<string, unknown>[]),
    ].map((run) => String(run.id));
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(second.next_cursor).toBeNull();
  });

  it("enforces one live project lease and stores only a claim digest", async () => {
    const firstId = String((await body(await createRun("create-a"))).id);
    const secondId = String((await body(await createRun("create-b", "homing/cloud-b"))).id);
    const claim = await app.request(`/api/v1/projects/${PROJECT_ID}/search-runs/${firstId}/claim`, {
      method: "POST",
    });
    expect(claim.status).toBe(200);
    const claimBody = await body(claim);
    const token = String(claimBody.claim_token);
    expect(token.length).toBeGreaterThan(32);
    const stored = repository.runs.get(firstId);
    expect(stored?.claimTokenDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);

    const blocked = await app.request(
      `/api/v1/projects/${PROJECT_ID}/search-runs/${secondId}/claim`,
      { method: "POST" },
    );
    expect(blocked.status).toBe(409);
    expect(await body(blocked)).toMatchObject({ error: { code: "run_already_claimed" } });

    const wrong = await app.request(
      `/api/v1/projects/${PROJECT_ID}/search-runs/${firstId}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_token: "wrong" }),
      },
    );
    expect(wrong.status).toBe(409);

    const heartbeat = await app.request(
      `/api/v1/projects/${PROJECT_ID}/search-runs/${firstId}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim_token: token }),
      },
    );
    expect(heartbeat.status).toBe(200);
    expect(await body(heartbeat)).toMatchObject({ status: "running" });
  });

  it("validates, sanitizes, completes, and durably replays the unchanged-client payload", async () => {
    const runId = String((await body(await createRun("create-complete"))).id);
    const claim = await body(
      await app.request(`/api/v1/projects/${PROJECT_ID}/search-runs/${runId}/claim`, {
        method: "POST",
      }),
    );
    const payload = {
      claim_token: claim.claim_token,
      status: "completed",
      output_cursor: "epochabc1:9",
      continuation: {
        protocol: 1,
        worker: "cloud-a",
        lanes: [
          {
            lane: "daft:sitemap",
            status: "ok",
            covered_through: "2026-08-20T12:00:00Z",
            items_seen: 4,
            items_new: 1,
          },
        ],
        next: "next_page",
        next_query: "drop this deprecated free text",
      },
      result_counts: { created: 1, trashed: 0, restored: 0 },
      summary: "See https://untrusted.example/<script>\rnext",
    };
    const complete = () =>
      app.request(`/api/v1/projects/${PROJECT_ID}/search-runs/${runId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "complete-1" },
        body: JSON.stringify(payload),
      });
    const first = await complete();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-homing-deprecation")).toContain("next_query");
    const firstBody = await body(first);
    expect(firstBody).toMatchObject({
      status: "completed",
      continuation: { protocol: 1, worker: "cloud-a", next: "next_page" },
      result_counts: { created: 1, trashed: 0, restored: 0 },
    });
    expect(JSON.stringify(firstBody)).not.toContain("next_query");
    expect(String(firstBody.summary)).toBe("See [link removed] next");

    const replay = await complete();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const changed = await app.request(
      `/api/v1/projects/${PROJECT_ID}/search-runs/${runId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "complete-1" },
        body: JSON.stringify({ ...payload, summary: "different" }),
      },
    );
    expect(changed.status).toBe(409);
  });

  it("rejects non-ISO coverage and fields outside the closed schemas", async () => {
    const runId = String((await body(await createRun("create-invalid"))).id);
    const claim = await body(
      await app.request(`/api/v1/projects/${PROJECT_ID}/search-runs/${runId}/claim`, {
        method: "POST",
      }),
    );
    const invalid = await app.request(
      `/api/v1/projects/${PROJECT_ID}/search-runs/${runId}/complete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "invalid-1" },
        body: JSON.stringify({
          claim_token: claim.claim_token,
          status: "completed",
          continuation: {
            lanes: [{ lane: "daft:sitemap", status: "ok", covered_through: "whenever" }],
          },
          result_counts: {},
        }),
      },
    );
    expect(invalid.status).toBe(422);
    expect(await body(invalid)).toMatchObject({ error: { code: "validation_error" } });
  });
});

describe("epoch change feed", () => {
  it("returns stable fresh cursors, monotonic pages, and expires legacy epochs", async () => {
    const repository = new InMemoryChangeRepository();
    repository.seedProject(PROJECT_ID, "epochABC1");
    const app = testApp({ changes: new ChangeService(repository) });

    const fresh = await app.request(`/api/v1/projects/${PROJECT_ID}/changes`);
    expect(await body(fresh)).toEqual({ items: [], next_cursor: "epochABC1:0" });

    for (const sequence of [1, 2]) {
      repository.add(PROJECT_ID, {
        sequence,
        eventType: "lead.updated",
        objectType: "lead",
        objectId: String(sequence),
        payload: { revision: sequence },
        tombstone: false,
        occurredAt: new Date(`2026-08-20T12:00:0${sequence}Z`),
      });
    }
    const page = await app.request(
      `/api/v1/projects/${PROJECT_ID}/changes?cursor=epochABC1%3A0&limit=1`,
    );
    expect(await body(page)).toMatchObject({
      items: [{ sequence: 1, object_id: "1" }],
      next_cursor: "epochABC1:1",
    });
    const unchanged = await app.request(
      `/api/v1/projects/${PROJECT_ID}/changes?cursor=epochABC1%3A2`,
    );
    expect(await body(unchanged)).toEqual({ items: [], next_cursor: "epochABC1:2" });

    for (const cursor of ["1", "otherEpoch:1"]) {
      const expired = await app.request(
        `/api/v1/projects/${PROJECT_ID}/changes?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(expired.status).toBe(410);
      expect(await body(expired)).toMatchObject({ error: { code: "cursor_expired" } });
    }
  });
});

describe("source-plan reviews and repair guidance", () => {
  it("keeps one bounded review, validates exact queries, and resolves by revision", async () => {
    const repository = new InMemorySourcePlanRepository();
    repository.seedProject(PROJECT_ID, 4);
    const app = testApp({ sourcePlans: new SourcePlanService(repository) });
    const report = () =>
      app.request(`/api/v1/projects/${PROJECT_ID}/source-plan-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_revision: 4 }),
      });
    const first = await report();
    const refreshed = await report();
    expect(first.status).toBe(201);
    expect(refreshed.status).toBe(200);
    const review = await body(first);
    expect((await body(refreshed)).id).toBe(review.id);
    expect(Object.keys(review).sort()).toEqual(
      [
        "id",
        "project_id",
        "status",
        "observed_prompt_revision",
        "resolved_prompt_revision",
        "opened_at",
        "last_reported_at",
        "resolved_at",
      ].sort(),
    );

    const list = await app.request("/api/v1/me/source-plan-reviews?status=open");
    expect(await body(list)).toMatchObject({ items: [{ id: review.id, status: "open" }] });
    for (const query of ["status=resolved", "status=open&extra=1", "status=open&status=open"]) {
      const rejected = await app.request(`/api/v1/me/source-plan-reviews?${query}`);
      expect(rejected.status).toBe(422);
    }

    const repair = await app.request("/api/v1/me/source-plan-repair");
    const repairBody = await body(repair);
    expect(repair.headers.get("cache-control")).toBe("private, no-store");
    expect(repairBody.open_review_count).toBe(1);
    expect(String(repairBody.prompt)).toContain("https://homing.test/agent/");
    expect(String(repairBody.prompt)).not.toContain(PROJECT_ID);

    const resolved = await app.request(
      `/api/v1/projects/${PROJECT_ID}/source-plan-review/${String(review.id)}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_revision: 4 }),
      },
    );
    expect(await body(resolved)).toMatchObject({ status: "resolved", resolved_prompt_revision: 4 });
    const replay = await app.request(
      `/api/v1/projects/${PROJECT_ID}/source-plan-review/${String(review.id)}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_revision: 4 }),
      },
    );
    expect(replay.status).toBe(200);
  });
});

describe("public unchanged agent kit", () => {
  it("builds deterministic substituted bytes and serves the complete allowlist contract", async () => {
    const first = buildKitPackage("https://homing.test");
    const second = buildKitPackage("https://homing.test");
    expect(first.archiveBytes).toEqual(second.archiveBytes);
    expect(first.archiveBytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(
      [...first.files.values()].every(
        (bytes) => !new TextDecoder().decode(bytes).includes("__HOMING_ORIGIN__"),
      ),
    ).toBe(true);
    expect(Object.keys(unzipSync(first.archiveBytes)).sort()).toEqual(
      first.manifest.files.map((entry) => entry.path).sort(),
    );
    expect(first.manifest.min_runtime_version).toBe("3.9");
    expect(first.manifest.archive.url).toBe(`https://homing.test/agent/pkg/${first.archiveName}`);
    for (const entry of first.manifest.files) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof entry.first_line).toBe("string");
      expect(typeof entry.last_line).toBe("string");
    }

    const app = testApp({ kit: first });
    const skill = await app.request("/agent/pkg/SKILL.md");
    expect(skill.status).toBe(200);
    expect(skill.headers.get("content-type")).toContain("text/markdown");
    expect(skill.headers.get("cache-control")).toBe("public, max-age=300");
    expect(skill.headers.get("content-disposition")).toBeNull();
    const etag = skill.headers.get("etag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const notModified = await app.request("/agent/pkg/SKILL.md", {
      headers: { "If-None-Match": `"other", W/${etag}` },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    const head = await app.request("/agent/pkg/SKILL.md", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    for (const path of [
      "/agent/pkg/unknown.md",
      "/agent/pkg/references/nested/nope.md",
      `/agent/pkg/homing-agent-kit-${first.version + 1}.zip`,
    ]) {
      expect((await app.request(path)).status).toBe(404);
    }
    expect(
      (
        await app.request("/agent/pkg/SKILL.md", {
          method: "POST",
        })
      ).status,
    ).toBe(405);
  });
});
