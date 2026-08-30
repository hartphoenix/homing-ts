import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildKitPackage } from "../../src/server/agent/kit";
import {
  createPostgresProjectAuthorizer,
  PostgresAgentRepository,
} from "../../src/server/agent/postgres-repository";
import { type AgentPrincipal, digest, RunService } from "../../src/server/agent/runs";
import { canonicalJsonBytes, canonicalJsonSha256 } from "../../src/server/agent/v2/canonical";
import { sourceQueryIdentity } from "../../src/server/agent/v2/identities";
import { PostgresV2Repository } from "../../src/server/agent/v2/postgres-repository";
import type { CreateRunInput, RunSnapshotProject } from "../../src/server/agent/v2/repository";
import type { RequiredEvidenceKey } from "../../src/server/agent/v2/schemas";
import { DrizzleAuthRepository } from "../../src/server/auth/drizzle-repository";
import { verifyImportedPassword } from "../../src/server/auth/password";
import { PostgresCollaborationRepository } from "../../src/server/collaboration/postgres-repository";
import * as schema from "../../src/server/db/schema";

const databaseUrl = process.env.HOMING_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const projectId = "11111111-1111-4111-8111-111111111111";
const tokenOne = "22222222-2222-4222-8222-222222222222";
const tokenTwo = "33333333-3333-4333-8333-333333333333";
const pbkdf2Fixture = "pbkdf2_sha256$260000$known-salt$VgacIdGkvu2udMuuojgq5qqZphxnf+nAQ/gA83qSwkI";
const argon2Fixture =
  "argon2$argon2id$v=19$m=8192,t=2,p=1$1Jx3YF0EKyZ0vaqZN+vpgtErMtZ9vH5edF2WDr6AJz0$bFMRVvuFxhg1K5hnHwJC/7ayARmxWc9OAyo9jfTd9hM";

describePostgres("PostgreSQL concurrency invariants", () => {
  let sqlClient: ReturnType<typeof postgres>;
  let runs: RunService;
  let collaboration: PostgresCollaborationRepository;
  let auth: DrizzleAuthRepository;
  let v2: PostgresV2Repository;

  beforeAll(() => {
    sqlClient = postgres(databaseUrl as string, {
      max: 12,
      prepare: false,
      idle_timeout: 5,
      connect_timeout: 5,
      onnotice: () => undefined,
    });
    runs = new RunService(
      new PostgresAgentRepository(sqlClient),
      createPostgresProjectAuthorizer(sqlClient),
    );
    const database = drizzle(sqlClient, { schema });
    v2 = new PostgresV2Repository(
      database as ConstructorParameters<typeof PostgresV2Repository>[0],
    );
    collaboration = new PostgresCollaborationRepository(
      database as ConstructorParameters<typeof PostgresCollaborationRepository>[0],
    );
    auth = new DrizzleAuthRepository(
      database as ConstructorParameters<typeof DrizzleAuthRepository>[0],
    );
  });

  beforeEach(async () => {
    await sqlClient`
      truncate table migration_records, users, auth_throttles, sessions restart identity cascade
    `;
    await sqlClient`
      insert into users (id, email, password_hash)
      values (1, 'one@example.test', 'test-only'), (2, 'two@example.test', 'test-only')
    `;
    await sqlClient`
      select setval(pg_get_serial_sequence('users', 'id'), (select max(id) from users))
    `;
    await sqlClient`
      insert into profiles (user_id, display_name)
      values (1, 'One'), (2, 'Two')
    `;
    await sqlClient`
      insert into projects
        (id, name, slug, current_prompt, criteria, creator_id, prompt_revision, feed_epoch)
      values
        (${projectId}, 'Postgres test', 'postgres-test', 'Find a place',
         ${JSON.stringify({ city: "Brooklyn" })}::jsonb, 1, 1, 'testepoch')
    `;
    await sqlClient`
      insert into prompt_revisions (project_id, revision, prompt, criteria, editor_id)
      values (${projectId}, 1, 'Find a place', ${JSON.stringify({ city: "Brooklyn" })}::jsonb, 1)
    `;
    await sqlClient`
      insert into project_memberships (project_id, user_id, role)
      values (${projectId}, 1, 'owner'), (${projectId}, 2, 'owner')
    `;
    await sqlClient`
      insert into agent_tokens
        (id, user_id, name, token_prefix, digest, scopes, project_ids, expires_at)
      values
        (${tokenOne}, 1, 'One A', 'one-a', ${"a".repeat(64)},
         ${JSON.stringify(["projects:read", "prompts:read", "runs:write"])}::jsonb,
         ${JSON.stringify([projectId])}::jsonb,
         now() + interval '30 days'),
        (${tokenTwo}, 1, 'One B', 'one-b', ${"b".repeat(64)},
         ${JSON.stringify(["projects:read", "prompts:read", "runs:write"])}::jsonb,
         ${JSON.stringify([projectId])}::jsonb,
         now() + interval '30 days')
    `;
  });

  async function createV2Snapshot(): Promise<RunSnapshotProject> {
    const acquisitionBasis = { locations: ["Brooklyn"] };
    const sourceQuery = { url: "https://www.zumper.com/homes/brooklyn" };
    const acquisitionBasisHash = canonicalJsonSha256(acquisitionBasis);
    const sourcePayload = {
      version: 1,
      adapter: "zumper-com" as const,
      query: sourceQuery,
      acquisition_basis_hash: acquisitionBasisHash,
    };
    const requiredEvidence: RequiredEvidenceKey[] = [
      "location",
      "price",
      "availability",
      "housing_type",
    ];
    const config = await v2.createConfigRevision({
      userId: 1,
      projectId,
      expectedRevision: 1,
      requiredEvidence,
      acquisitionBasis,
      sourceQueries: [
        {
          adapter: "zumper-com",
          normalizedQuery: sourceQuery,
          queryIdentity: sourceQueryIdentity(projectId, "zumper-com", sourceQuery),
          acquisitionBasisHash,
          canonicalBytes: canonicalJsonBytes(sourcePayload),
          canonicalSha256: canonicalJsonSha256(sourcePayload),
        },
      ],
    });
    const queryId = config.sourceQueryIds[0];
    if (!queryId) throw new Error("v2 config did not create a source query");
    const query = await v2.getSourceQueryRevision(1, projectId, queryId);
    if (!query) throw new Error("v2 source query disappeared after creation");
    return {
      projectId,
      promptRevisionId: config.id,
      promptRevision: config.revision,
      canonicalSha256: config.canonicalSha256,
      queries: [
        {
          sourceQueryRevisionId: query.id,
          sourceQueryRevision: query.revision,
          canonicalSha256: query.canonicalSha256,
        },
      ],
    };
  }

  afterAll(async () => {
    await sqlClient?.end({ timeout: 5 });
  });

  it("replays concurrent requests per token and permits the same key across tokens", async () => {
    const principalOne: AgentPrincipal = {
      userId: 1,
      tokenId: tokenOne,
      scopes: ["projects:read", "prompts:read", "runs:write"],
      projectIds: [projectId],
    };
    const principalTwo: AgentPrincipal = { ...principalOne, tokenId: tokenTwo };
    const input = { agent_label: "postgres/integration", input_cursor: "testepoch:0" };

    const replays = await Promise.all(
      Array.from({ length: 8 }, () => runs.create(projectId, principalOne, input, "same-key")),
    );
    expect(new Set(replays.map((result) => String(result.body.id))).size).toBe(1);

    const distinct = await Promise.all([
      runs.create(projectId, principalOne, input, "shared-key"),
      runs.create(projectId, principalTwo, input, "shared-key"),
    ]);
    const distinctIds = distinct.map((result) => String(result.body.id));
    expect(new Set(distinctIds).size).toBe(2);

    const claims = await Promise.allSettled([
      runs.claim(projectId, distinctIds[0] as string, principalOne),
      runs.claim(projectId, distinctIds[1] as string, principalTwo),
    ]);
    const claimDiagnostics = claims.map((result) =>
      result.status === "fulfilled"
        ? "fulfilled"
        : `${String((result.reason as { code?: unknown }).code)}:${String((result.reason as Error).message)}`,
    );
    expect(
      claims.filter((result) => result.status === "fulfilled"),
      claimDiagnostics.join(" | "),
    ).toHaveLength(1);
    expect(claims.filter((result) => result.status === "rejected")).toHaveLength(1);
    const claimedIndex = claims.findIndex((result) => result.status === "fulfilled");
    const claimedResult = claims[claimedIndex];
    expect(claimedResult?.status).toBe("fulfilled");
    if (claimedResult?.status !== "fulfilled") throw new Error("Expected one claimed run.");
    const claimToken = String(claimedResult.value.claim_token);
    const [storedClaim] = await sqlClient<Array<{ claim_token_digest: string }>>`
      select claim_token_digest from search_runs where id = ${distinctIds[claimedIndex] as string}
    `;
    expect(storedClaim?.claim_token_digest).toBe(digest(claimToken));
    expect(storedClaim?.claim_token_digest).not.toContain(claimToken);

    await sqlClient`
      update search_runs set lease_expires_at = now() - interval '1 minute'
       where id = ${distinctIds[claimedIndex] as string}
    `;
    const reclaimIndex = claimedIndex === 0 ? 1 : 0;
    const reclaimed = await runs.claim(
      projectId,
      distinctIds[reclaimIndex] as string,
      reclaimIndex === 0 ? principalOne : principalTwo,
    );
    expect(reclaimed.claim_token).not.toBe(claimToken);

    const [sequenceState] = await sqlClient<
      Array<{ latest: string; total: string; distinct_total: string }>
    >`
      select project.latest_change_sequence::text as latest,
             count(change.sequence)::text as total,
             count(distinct change.sequence)::text as distinct_total
        from projects project
        left join project_changes change on change.project_id = project.id
       where project.id = ${projectId}
       group by project.latest_change_sequence
    `;
    expect(sequenceState).toEqual({ latest: "5", total: "5", distinct_total: "5" });
  });

  it("replays concurrent v2 invocation creation without duplicate runs", async () => {
    const snapshot = await createV2Snapshot();
    const input: CreateRunInput = {
      userId: 1,
      tokenId: tokenOne,
      invocationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentLabel: "postgres/v2-integrity",
      projects: [snapshot],
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => v2.createRun(input)));
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(7);
  });

  it("resolves concurrent source-query creation without a unique-race error", async () => {
    const acquisitionBasis = { locations: ["Brooklyn"] };
    const sourceQuery = { url: "https://www.zumper.com/homes/brooklyn" };
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        v2.createConfigRevision({
          userId: 1,
          projectId,
          expectedRevision: 1,
          requiredEvidence: ["location", "price", "availability", "housing_type"],
          acquisitionBasis,
          sourceQueries: [
            {
              adapter: "zumper-com",
              normalizedQuery: sourceQuery,
              queryIdentity: sourceQueryIdentity(projectId, "zumper-com", sourceQuery),
              acquisitionBasisHash: canonicalJsonSha256(acquisitionBasis),
              canonicalBytes: canonicalJsonBytes({
                version: 1,
                adapter: "zumper-com",
                query: sourceQuery,
                acquisition_basis_hash: canonicalJsonSha256(acquisitionBasis),
              }),
              canonicalSha256: canonicalJsonSha256({
                version: 1,
                adapter: "zumper-com",
                query: sourceQuery,
                acquisition_basis_hash: canonicalJsonSha256(acquisitionBasis),
              }),
            },
          ],
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(rejected).toHaveLength(7);
    expect(
      rejected.every(
        (attempt) =>
          (attempt.reason as { code?: unknown }).code === "conflict" &&
          (attempt.reason as { status?: unknown }).status === 409,
      ),
    ).toBe(true);
    const [sourceCount] = await sqlClient`
      select count(*)::text as count
        from source_query_revisions
       where project_id = ${projectId}
    `;
    expect(sourceCount?.count).toBe("1");
  });

  it("resolves concurrent absent-lead deliveries to one lead and one observation", async () => {
    const snapshot = await createV2Snapshot();
    const input = {
      userId: 1,
      tokenId: tokenOne,
      projectId,
      promptRevisionId: snapshot.promptRevisionId,
      promptRevision: snapshot.promptRevision,
      factsHash: "e".repeat(64),
      disposition: "kept" as const,
      reason: "meets requirements",
      unknowns: [],
      lead: {
        source: "zumper-com" as const,
        sourceListingId: "concurrent-delivery-1",
        canonicalUrl: "https://example.test/concurrent-delivery-1",
        title: "Concurrent delivery",
        summary: "",
        location: "Brooklyn",
        priceDisplay: "$2,500",
        priceAmount: "2500.00",
        priceCurrency: "USD",
        availability: "now",
        housingType: "entire" as const,
        listedAt: null,
        attributes: {},
        verificationNotes: "",
      },
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => v2.deliver(input)));
    expect(new Set(results.map((result) => result.leadId)).size).toBe(1);
    expect(new Set(results.map((result) => result.observationId)).size).toBe(1);
    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results.filter((result) => result.status === "existing")).toHaveLength(7);
    const [counts] = await sqlClient`
      select
        (select count(*)::text from leads where project_id = ${projectId}) as leads,
        (select count(*)::text from match_observations where project_id = ${projectId}) as observations
    `;
    expect(counts).toEqual({ leads: "1", observations: "1" });
  });

  it("rejects cross-project v2 references at the database boundary", async () => {
    const otherProjectId = "88888888-8888-4888-8888-888888888888";
    await sqlClient`
      insert into projects
        (id, name, slug, current_prompt, criteria, creator_id, prompt_revision, feed_epoch)
      values
        (${otherProjectId}, 'Other project', 'other-project', 'Other prompt', '{}'::jsonb, 1, 1, 'other')
    `;
    const [otherRevision] = await sqlClient`
      insert into prompt_revisions (project_id, revision, prompt, criteria, editor_id)
      values (${otherProjectId}, 1, 'Other prompt', '{}'::jsonb, 1)
      returning id
    `;
    const snapshot = await createV2Snapshot();
    const sourceQueryId = snapshot.queries[0]?.sourceQueryRevisionId;
    if (!sourceQueryId || snapshot.promptRevisionId === null || !otherRevision?.id) {
      throw new Error("incomplete v2 isolation fixture");
    }
    await expect(
      sqlClient`
        insert into prompt_revision_source_queries
          (project_id, prompt_revision_id, source_query_revision_id, position)
        values (${otherProjectId}, ${snapshot.promptRevisionId}, ${sourceQueryId}, 0)
      `,
    ).rejects.toThrow();
    await expect(
      sqlClient`
        update projects
           set current_config_revision_id = ${otherRevision.id}
         where id = ${projectId}
      `,
    ).rejects.toThrow();
  });

  it("returns a typed conflict when an invocation is replayed with another snapshot", async () => {
    const snapshot = await createV2Snapshot();
    const input: CreateRunInput = {
      userId: 1,
      tokenId: tokenOne,
      invocationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      agentLabel: "postgres/v2-integrity",
      projects: [snapshot],
    };
    await v2.createRun(input);
    const changedSnapshot: RunSnapshotProject = {
      ...snapshot,
      canonicalSha256: "f".repeat(64),
    };
    await expect(v2.createRun({ ...input, projects: [changedSnapshot] })).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
  });

  it("rejects duplicate snapshot entries as a typed conflict", async () => {
    const snapshot = await createV2Snapshot();
    const input: CreateRunInput = {
      userId: 1,
      tokenId: tokenOne,
      invocationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      agentLabel: "postgres/v2-integrity",
      projects: [snapshot, snapshot],
    };
    await expect(v2.createRun(input)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("requires submitted source queries to be configured and ready", async () => {
    const snapshot = await createV2Snapshot();
    const query = snapshot.queries[0];
    if (!query) throw new Error("v2 snapshot has no source query");
    const input: CreateRunInput = {
      userId: 1,
      tokenId: tokenOne,
      invocationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agentLabel: "postgres/v2-integrity",
      projects: [snapshot],
    };
    const foreignQuerySnapshot: RunSnapshotProject = {
      ...snapshot,
      queries: [
        {
          ...query,
          sourceQueryRevisionId: "99999999-9999-4999-8999-999999999999",
        },
      ],
    };
    await expect(
      v2.createRun({ ...input, projects: [foreignQuerySnapshot] }),
    ).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });

    await sqlClient`
      update source_query_revisions set status = 'needs_review'
       where id = ${query.sourceQueryRevisionId}
    `;
    await expect(v2.createRun(input)).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("does not expose historical v2 configuration for an inactive project", async () => {
    const snapshot = await createV2Snapshot();
    const queryId = snapshot.queries[0]?.sourceQueryRevisionId;
    if (!queryId || snapshot.promptRevisionId === null) throw new Error("incomplete v2 snapshot");
    await collaboration.updateProject(projectId, { status: "trashed" });
    expect(await v2.listProjects(1)).toEqual([]);
    expect(await v2.getConfigRevision(1, projectId, snapshot.promptRevision)).toBeNull();
    expect(await v2.getSourceQueryRevision(1, projectId, queryId)).toBeNull();
  });

  it("serializes final-owner changes and optimistic prompt revisions", async () => {
    const ownerChanges = await Promise.allSettled([
      collaboration.transaction((transaction) =>
        transaction.changeMembershipRole(projectId, 1, "editor", 1),
      ),
      collaboration.transaction((transaction) =>
        transaction.changeMembershipRole(projectId, 2, "editor", 2),
      ),
    ]);
    expect(ownerChanges.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(ownerChanges.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await collaboration.countOwners(projectId)).toBe(1);

    const promptChanges = await Promise.allSettled([
      collaboration.transaction((transaction) =>
        transaction.updatePrompt(projectId, 1, "First", { source: "one" }, 1),
      ),
      collaboration.transaction((transaction) =>
        transaction.updatePrompt(projectId, 1, "Second", { source: "two" }, 2),
      ),
    ]);
    expect(promptChanges.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(promptChanges.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await collaboration.getProject(projectId))?.promptRevision).toBe(2);
    expect(await collaboration.listPromptRevisions(projectId)).toHaveLength(2);
  });

  it("keeps the current v2 configuration aligned across text and acquisition edits", async () => {
    const sourceQuery = { url: "https://www.zumper.com/homes/brooklyn" };
    const acquisitionBasis = { locations: ["Brooklyn"] };
    const sourcePayload = {
      version: 1,
      adapter: "zumper-com",
      query: sourceQuery,
      acquisition_basis_hash: canonicalJsonSha256(acquisitionBasis),
    };
    const sourceBytes = canonicalJsonBytes(sourcePayload);
    const configPayload = {
      version: 1,
      prompt: "Find a place",
      criteria: { city: "Brooklyn" },
      required_evidence: ["location", "price", "availability", "housing_type"],
      acquisition_basis: acquisitionBasis,
      source_queries: [],
    };
    const [source] = await sqlClient`
      insert into source_query_revisions
        (project_id, adapter, revision, normalized_query, query_identity,
         acquisition_basis_hash, canonical_bytes, canonical_sha256, status)
      values
        (${projectId}, 'zumper-com', 1, ${JSON.stringify(sourceQuery)}::jsonb,
         ${canonicalJsonSha256({ project_id: projectId, adapter: "zumper-com", query: sourceQuery })},
         ${canonicalJsonSha256(acquisitionBasis)}, ${sourceBytes}, ${canonicalJsonSha256(sourcePayload)}, 'ready')
      returning id
    `;
    const configWithRef = {
      ...configPayload,
      source_queries: [
        { id: source?.id, revision: 1, sha256: canonicalJsonSha256(sourcePayload), position: 0 },
      ],
    };
    const configBytes = canonicalJsonBytes(configWithRef);
    const [config] = await sqlClient`
      insert into prompt_revisions
        (project_id, revision, prompt, criteria, config_status, required_evidence,
         acquisition_basis, canonical_bytes, canonical_sha256, editor_id)
      values
        (${projectId}, 2, 'Find a place', ${JSON.stringify({ city: "Brooklyn" })}::jsonb, 'complete',
         ${JSON.stringify(configPayload.required_evidence)}::jsonb,
         ${JSON.stringify(acquisitionBasis)}::jsonb, ${configBytes}, ${canonicalJsonSha256(configWithRef)}, 1)
      returning id
    `;
    await sqlClient`
      insert into prompt_revision_source_queries (project_id, prompt_revision_id, source_query_revision_id, position)
      values (${projectId}, ${config?.id}, ${source?.id}, 0)
    `;
    await sqlClient`
      update projects set prompt_revision = 2, current_config_revision_id = ${config?.id}
      where id = ${projectId}
    `;

    const textEdit = await collaboration.transaction((transaction) =>
      transaction.updatePrompt(projectId, 2, "Find a place with transit", { city: "Brooklyn" }, 1),
    );
    expect(textEdit.revision.revision).toBe(3);
    const [textConfig] = await sqlClient`
      select config_status, canonical_sha256, required_evidence, acquisition_basis
        from prompt_revisions where id = (select current_config_revision_id from projects where id = ${projectId})
    `;
    expect(textConfig?.config_status).toBe("complete");
    expect(textConfig?.required_evidence).toEqual(configPayload.required_evidence);

    const acquisitionEdit = await collaboration.transaction((transaction) =>
      transaction.updatePrompt(projectId, 3, "Find a place with transit", { city: "Queens" }, 1),
    );
    expect(acquisitionEdit.revision.revision).toBe(4);
    const [reviewConfig] = await sqlClient`
      select config_status from prompt_revisions
       where project_id = ${projectId} and revision = 4
    `;
    const reviewSources = await sqlClient`
      select source.status
        from prompt_revision_source_queries link
        join source_query_revisions source on source.id = link.source_query_revision_id
       where link.project_id = ${projectId}
         and link.prompt_revision_id = (select id from prompt_revisions where project_id = ${projectId} and revision = 4)
    `;
    expect(reviewConfig?.config_status).toBe("needs_review");
    expect(reviewSources).toEqual([{ status: "needs_review" }]);
  });

  it("linearizes membership revocation before a content authorization check", async () => {
    let releaseRemoval!: () => void;
    let removalLocked!: () => void;
    const removalReady = new Promise<void>((resolve) => {
      removalLocked = resolve;
    });
    const removalRelease = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const removal = collaboration.transaction(async (transaction) => {
      await transaction.assertOwner(projectId, 1);
      removalLocked();
      await removalRelease;
      await transaction.removeMembershipSafely(projectId, 2, 1);
    });
    await removalReady;

    const mutation = collaboration.transaction(async (transaction) => {
      await transaction.assertMembership(projectId, 2);
      await transaction.updatePrompt(projectId, 1, "Should not commit", {}, 2);
    });
    await delay(25);
    releaseRemoval();
    await removal;
    await expect(mutation).rejects.toMatchObject({ code: "not_found" });
    expect(await collaboration.getMembership(projectId, 2)).toBeNull();
    expect((await collaboration.getProject(projectId))?.currentPrompt).toBe("Find a place");
  });

  it("rejects project and lead mutations queued behind trash operations", async () => {
    let releaseProjectTrash!: () => void;
    let projectTrashLocked!: () => void;
    const projectTrashReady = new Promise<void>((resolve) => {
      projectTrashLocked = resolve;
    });
    const projectTrashRelease = new Promise<void>((resolve) => {
      releaseProjectTrash = resolve;
    });
    const projectTrash = collaboration.transaction(async (transaction) => {
      await transaction.assertOwner(projectId, 1);
      projectTrashLocked();
      await projectTrashRelease;
      await transaction.updateProject(projectId, { status: "trashed" });
    });
    await projectTrashReady;
    const projectMutation = collaboration.transaction(async (transaction) => {
      await transaction.assertMembership(projectId, 2);
      await transaction.updatePrompt(projectId, 1, "Must not commit", {}, 2);
    });
    await delay(25);
    releaseProjectTrash();
    await projectTrash;
    await expect(projectMutation).rejects.toMatchObject({ code: "not_found" });
    expect((await collaboration.getProject(projectId))?.status).toBe("trashed");

    await collaboration.updateProject(projectId, { status: "active" });
    const leadId = "44444444-4444-4444-8444-444444444449";
    const [created] = await collaboration.bulkUpsertLeads(projectId, 1, [
      {
        id: leadId,
        source: "race-test",
        url: "https://example.test/race",
        title: "Race target",
      },
    ]);
    if (!created?.lead) throw new Error("race lead was not created");

    let releaseLeadTrash!: () => void;
    let leadTrashLocked!: () => void;
    const leadTrashReady = new Promise<void>((resolve) => {
      leadTrashLocked = resolve;
    });
    const leadTrashRelease = new Promise<void>((resolve) => {
      releaseLeadTrash = resolve;
    });
    const leadTrash = collaboration.transaction(async (transaction) => {
      await transaction.assertMembership(projectId, 1);
      leadTrashLocked();
      await leadTrashRelease;
      await transaction.setLeadStatus(projectId, leadId, "trashed", 1, created.lead?.revision);
    });
    await leadTrashReady;
    const interestMutation = collaboration.transaction(async (transaction) => {
      await transaction.assertMembership(projectId, 2);
      await transaction.setInterest(projectId, leadId, 2, true);
    });
    await delay(25);
    releaseLeadTrash();
    await leadTrash;
    await expect(interestMutation).rejects.toMatchObject({ code: "not_found" });
    expect(await collaboration.getInterest(projectId, leadId, 2)).toBe(false);
  });

  it("paginates every browser lead sort without gaps or duplicates", async () => {
    const sortableLeads = [
      {
        id: "44444444-4444-4444-8444-444444444441",
        source: "alpha",
        price: "1000.00",
        listedAt: "2026-01-05",
      },
      {
        id: "44444444-4444-4444-8444-444444444442",
        source: "beta",
        price: "2000.00",
        listedAt: "2026-01-04",
      },
      {
        id: "44444444-4444-4444-8444-444444444443",
        source: "alpha",
        price: null,
        listedAt: null,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        source: "gamma",
        price: "1000.00",
        listedAt: "2026-01-03",
      },
      {
        id: "44444444-4444-4444-8444-444444444445",
        source: "beta",
        price: "3000.00",
        listedAt: null,
      },
    ] as const;
    for (const lead of sortableLeads) {
      await sqlClient`
        insert into leads
          (id, project_id, source, canonical_url, title, price_amount, listed_at, creator_id)
        values
          (${lead.id}, ${projectId}, ${lead.source}, ${`https://example.test/${lead.id}`},
           ${lead.id}, ${lead.price}, ${lead.listedAt}, 1)
      `;
    }

    const expectations = {
      price_asc: ["441", "444", "442", "445", "443"],
      price_desc: ["445", "442", "444", "441", "443"],
      source_asc: ["441", "443", "442", "445", "444"],
      source_desc: ["444", "445", "442", "443", "441"],
      days_asc: ["441", "442", "444", "443", "445"],
      days_desc: ["444", "442", "441", "443", "445"],
    } as const;

    for (const [sort, expectedSuffixes] of Object.entries(expectations)) {
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await collaboration.listLeads(projectId, {
          status: "active",
          limit: 2,
          sort: sort as keyof typeof expectations,
          ...(after ? { after } : {}),
        });
        seen.push(...page.items.map((lead) => lead.id.slice(-3)));
        after = page.next;
      } while (after);
      expect(seen, sort).toEqual(expectedSuffixes);
    }
  });

  it("refuses invitations after their project is trashed", async () => {
    const now = new Date("2026-08-20T16:00:00Z");
    const invitationDigest = "9".repeat(64);
    await sqlClient`
      insert into project_invitations
        (project_id, email, role, inviter_id, token_digest, expires_at)
      values
        (${projectId}, 'two@example.test', 'viewer', 1, ${invitationDigest},
         ${new Date("2026-08-21T16:00:00Z").toISOString()})
    `;
    await collaboration.updateProject(projectId, { status: "trashed" });

    await expect(auth.findPendingInvitation(invitationDigest, now)).resolves.toBeNull();
    await expect(auth.acceptInvitation(invitationDigest, 2, now)).resolves.toBeNull();
    await expect(
      auth.registerInvitedUser({
        invitationDigest,
        email: "two@example.test",
        displayName: "Two",
        passwordHash: "unused",
        now,
      }),
    ).resolves.toBeNull();
  });

  it("accounts for concurrent device polls under one row lock", async () => {
    const digest = "c".repeat(64);
    const link = await auth.createAgentLink({
      deviceCodeDigest: digest,
      userCode: "ABC123",
      agentLabel: "Concurrent polling",
      environmentNote: "",
      requestedCadenceMinutes: null,
      expiresAt: new Date("2026-08-20T17:00:00Z"),
      intervalSeconds: 5,
    });
    expect(link).toBeTruthy();
    const now = new Date("2026-08-20T16:00:00Z");
    const polls = await Promise.all(
      Array.from({ length: 12 }, () => auth.pollAgentLink(digest, now, 400)),
    );
    expect(polls.filter((poll) => poll.outcome === "authorization_pending")).toHaveLength(1);
    expect(polls.filter((poll) => poll.outcome === "slow_down")).toHaveLength(11);
    expect((await auth.getAgentLinkByDigest(digest))?.pollCount).toBe(12);
  });

  it("registers an invited user atomically and rolls back partial failures", async () => {
    const now = new Date("2026-08-20T16:00:00Z");
    const expiresAt = new Date("2026-08-21T16:00:00Z");
    const acceptedDigest = "d".repeat(64);
    const rollbackDigest = "e".repeat(64);
    await sqlClient`
      insert into project_invitations
        (project_id, email, role, inviter_id, token_digest, expires_at)
      values
        (${projectId}, 'new@example.test', 'editor', 1, ${acceptedDigest}, ${expiresAt.toISOString()}),
        (${projectId}, 'rollback@example.test', 'viewer', 1, ${rollbackDigest}, ${expiresAt.toISOString()})
    `;

    const registered = await auth.registerInvitedUser({
      invitationDigest: acceptedDigest,
      email: "new@example.test",
      displayName: "New Member",
      passwordHash: "test-only-password-hash",
      now,
    });
    expect(registered).toMatchObject({ projectId, user: { email: "new@example.test" } });
    const [acceptedState] = await sqlClient<
      Array<{
        accepted: boolean;
        audit_total: string;
        change_total: string;
        membership_total: string;
        profile_total: string;
      }>
    >`
      select invitation.accepted_at is not null as accepted,
             (select count(*)::text from audit_events where action = 'invitation.accepted') as audit_total,
             (select count(*)::text from project_changes
               where event_type in ('membership.joined', 'invitation.accepted')) as change_total,
             (select count(*)::text from project_memberships membership
               join users member on member.id = membership.user_id
              where membership.project_id = ${projectId} and member.email = 'new@example.test') as membership_total,
             (select count(*)::text from profiles profile
               join users member on member.id = profile.user_id
              where member.email = 'new@example.test') as profile_total
        from project_invitations invitation
       where invitation.token_digest = ${acceptedDigest}
    `;
    expect(acceptedState).toEqual({
      accepted: true,
      audit_total: "1",
      change_total: "2",
      membership_total: "1",
      profile_total: "1",
    });
    expect(
      await auth.registerInvitedUser({
        invitationDigest: acceptedDigest,
        email: "new@example.test",
        displayName: "Replay",
        passwordHash: "test-only-password-hash",
        now,
      }),
    ).toBeNull();

    await expect(
      auth.registerInvitedUser({
        invitationDigest: rollbackDigest,
        email: "rollback@example.test",
        displayName: "x".repeat(121),
        passwordHash: "test-only-password-hash",
        now,
      }),
    ).rejects.toBeTruthy();
    const [rollbackState] = await sqlClient<
      Array<{
        accepted: boolean;
        audit_total: string;
        change_total: string;
        membership_total: string;
        profile_total: string;
        user_total: string;
      }>
    >`
      select invitation.accepted_at is not null as accepted,
             (select count(*)::text from audit_events
               where object_id = invitation.id::text) as audit_total,
             (select count(*)::text from project_changes
               where object_id = invitation.id::text) as change_total,
             (select count(*)::text from project_memberships membership
               join users member on member.id = membership.user_id
              where member.email = 'rollback@example.test') as membership_total,
             (select count(*)::text from profiles profile
               join users member on member.id = profile.user_id
              where member.email = 'rollback@example.test') as profile_total,
             (select count(*)::text from users
               where email = 'rollback@example.test') as user_total
        from project_invitations invitation
       where invitation.token_digest = ${rollbackDigest}
    `;
    expect(rollbackState).toEqual({
      accepted: false,
      audit_total: "0",
      change_total: "0",
      membership_total: "0",
      profile_total: "0",
      user_total: "0",
    });
  });

  it("imports complete frozen Django access and project state with authority rotated", async () => {
    const migrationProjectId = "55555555-5555-4555-8555-555555555555";
    const secondProjectId = "66666666-6666-4666-8666-666666666666";
    const activeLeadId = "77777777-7777-4777-8777-777777777777";
    const trashedLeadId = "88888888-8888-4888-8888-888888888888";
    const rotatedTokenId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await sqlClient`truncate table migration_records, users restart identity cascade`;
    await sqlClient`drop schema if exists django_source cascade`;
    await sqlClient`create schema django_source`;
    try {
      await sqlClient`
        create table django_source.accounts_user (
          id bigint primary key,
          email varchar(254) not null,
          password text not null,
          last_login timestamptz,
          is_staff boolean not null,
          is_superuser boolean not null,
          is_active boolean not null,
          date_joined timestamptz not null,
          updated_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.accounts_savedprompt (
          id bigint primary key,
          user_id bigint not null,
          title varchar(200) not null,
          prompt text not null,
          created_at timestamptz not null,
          updated_at timestamptz not null
        )
      `;
      await sqlClient`create table django_source.accounts_agenttoken (id uuid primary key)`;
      await sqlClient`create table django_source.accounts_agentlink (id uuid primary key)`;
      await sqlClient`create table django_source.accounts_auththrottle (id bigint primary key)`;
      await sqlClient`create table django_source.django_session (session_key varchar(40) primary key)`;
      await sqlClient`
        create table django_source.accounts_profile (
          user_id bigint primary key,
          display_name varchar(120) not null,
          timezone varchar(64) not null,
          bio text not null,
          personal_details jsonb not null,
          agent_paused_until timestamptz,
          updated_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.projects_project (
          id uuid primary key,
          name varchar(200) not null,
          slug varchar(220) not null,
          description text not null,
          prompt text not null,
          criteria jsonb not null,
          status varchar(16) not null,
          prompt_revision integer not null,
          creator_id bigint not null,
          created_at timestamptz not null,
          updated_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.projects_projectmembership (
          project_id uuid not null,
          user_id bigint not null,
          role varchar(16) not null,
          joined_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.projects_promptrevision (
          id bigint primary key,
          project_id uuid not null,
          revision integer not null,
          prompt text not null,
          criteria jsonb not null,
          editor_id bigint not null,
          created_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.projects_projectinvitation (
          id uuid primary key,
          project_id uuid not null,
          invited_email varchar(254) not null,
          role varchar(16) not null,
          inviter_id bigint not null,
          token_digest varchar(64) not null,
          expires_at timestamptz not null,
          accepted_at timestamptz,
          revoked_at timestamptz,
          created_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.projects_searchrun (
          id uuid primary key,
          project_id uuid not null,
          user_id bigint not null,
          agent_token_id uuid,
          agent_label varchar(160) not null,
          prompt_revision integer not null,
          prompt_snapshot text not null,
          criteria_snapshot jsonb not null,
          status varchar(16) not null,
          lease_owner varchar(160) not null,
          lease_expires_at timestamptz,
          claim_token varchar(64) not null,
          attempt_count integer not null,
          input_cursor varchar(500) not null,
          output_cursor varchar(500) not null,
          continuation jsonb not null,
          result_counts jsonb not null,
          summary text not null,
          idempotency_key varchar(200) not null,
          created_at timestamptz not null,
          started_at timestamptz,
          completed_at timestamptz,
          updated_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.projects_lead (
          id uuid primary key,
          project_id uuid not null,
          source varchar(160) not null,
          source_listing_id varchar(200) not null,
          canonical_url varchar(2000) not null,
          identity_hash varchar(64) not null,
          source_url varchar(2000) not null,
          title varchar(500) not null,
          summary text not null,
          location varchar(500) not null,
          price_display varchar(120) not null,
          price_amount numeric(10,2),
          price_currency varchar(3) not null,
          availability varchar(500) not null,
          housing_type varchar(16) not null,
          date_confidence varchar(16) not null,
          park_notes varchar(1000) not null,
          attributes jsonb not null,
          verification_notes text not null,
          status varchar(16) not null,
          trashed_by_id bigint,
          trashed_at timestamptz,
          creator_id bigint not null,
          revision integer not null,
          created_at timestamptz not null,
          updated_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.projects_leadinterest (
          lead_id uuid not null,
          user_id bigint not null,
          created_at timestamptz not null
        )
      `;
      await sqlClient`
        create table django_source.projects_leadcomment (
          id bigint primary key,
          lead_id uuid not null,
          author_id bigint not null,
          parent_id bigint,
          body text not null,
          created_at timestamptz not null,
          edited_at timestamptz,
          deleted_at timestamptz
        )
      `;
      await sqlClient`
        create table django_source.projects_sourceplanreview (
          id uuid primary key,
          project_id uuid not null,
          user_id bigint not null,
          reporting_agent_token_id uuid,
          resolving_agent_token_id uuid,
          status varchar(16) not null,
          observed_prompt_revision integer not null,
          resolved_prompt_revision integer,
          opened_at timestamptz not null,
          last_reported_at timestamptz not null,
          resolved_at timestamptz
        )
      `;
      await sqlClient`
        create table django_source.projects_auditevent (
          id bigint primary key,
          project_id uuid,
          action varchar(100) not null,
          object_type varchar(80) not null,
          object_id varchar(100) not null,
          actor_kind varchar(24) not null,
          actor_id bigint,
          token_id uuid,
          request_id varchar(100) not null,
          summary jsonb not null,
          created_at timestamptz not null
        )
      `;
      await sqlClient`create table django_source.projects_idempotencykey (id bigint primary key)`;
      await sqlClient`create table django_source.projects_projectchange (id bigint primary key)`;
      await sqlClient`insert into django_source.accounts_agenttoken values (${rotatedTokenId})`;
      await sqlClient`
        insert into django_source.accounts_agentlink
        values ('ffffffff-ffff-4fff-8fff-ffffffffffff')
      `;
      await sqlClient`insert into django_source.accounts_auththrottle values (1)`;
      await sqlClient`
        insert into django_source.django_session values ('migration-session-marker')
      `;
      await sqlClient`insert into django_source.projects_idempotencykey values (1)`;
      await sqlClient`insert into django_source.projects_projectchange values (1)`;
      await sqlClient`
        insert into django_source.accounts_user
          (id, email, password, last_login, is_staff, is_superuser, is_active, date_joined, updated_at)
        values
          (7, 'HART@example.test', ${argon2Fixture}, '2026-08-20T12:00:00Z', true, true, true,
           '2026-08-01T12:00:00Z', '2026-08-19T12:00:00Z'),
          (9, 'partner@example.test', ${pbkdf2Fixture}, null, false, false, true,
           '2026-08-02T12:00:00Z', '2026-08-19T12:00:00Z'),
          (11, 'former@example.test', ${argon2Fixture}, null, false, false, true,
           '2026-08-03T12:00:00Z', '2026-08-19T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.accounts_profile
          (user_id, display_name, timezone, bio, personal_details, agent_paused_until, updated_at)
        values
          (7, 'Hart', 'America/New_York', 'Builder',
           '{"exact":900719925474099312345,"housing":"current"}'::jsonb, null,
           '2026-08-19T12:00:00.123456Z'),
          (9, 'Partner', 'America/New_York', '', '{}'::jsonb,
           '2026-08-22T12:00:00Z', '2026-08-19T12:00:00Z'),
          (11, 'Former member', 'UTC', 'Archived author', '{}'::jsonb,
           null, '2026-08-19T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.accounts_savedprompt
          (id, user_id, title, prompt, created_at, updated_at)
        values
          (15, 11, 'Archived prompt', 'Keep this user-authored content',
           '2026-08-05T12:00:00Z', '2026-08-06T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_project
          (id, name, slug, description, prompt, criteria, status, prompt_revision, creator_id,
           created_at, updated_at)
        values
          (${migrationProjectId}, 'Imported Homing', 'imported-homing', 'Current shared search',
           'Use the current search brief', ${JSON.stringify({ borough: "Brooklyn" })}::jsonb,
           'active', 3, 7, '2026-08-03T12:00:00Z', '2026-08-19T12:00:00Z'),
          (${secondProjectId}, 'Second search', 'second-search', 'Another intact project',
           'Second project brief', ${JSON.stringify({ borough: "Queens" })}::jsonb,
           'active', 1, 11, '2026-08-04T12:00:00Z', '2026-08-20T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_projectmembership
          (project_id, user_id, role, joined_at)
        values
          (${migrationProjectId}, 7, 'owner', '2026-08-03T12:00:00Z'),
          (${migrationProjectId}, 9, 'editor', '2026-08-04T12:00:00Z'),
          (${secondProjectId}, 11, 'owner', '2026-08-04T12:00:00Z'),
          (${secondProjectId}, 7, 'viewer', '2026-08-05T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_promptrevision
          (id, project_id, revision, prompt, criteria, editor_id, created_at)
        values
          (31, ${migrationProjectId}, 1, 'Initial brief', '{}'::jsonb, 7, '2026-08-03T12:00:00Z'),
          (32, ${migrationProjectId}, 2, 'Refined brief', '{}'::jsonb, 9, '2026-08-10T12:00:00Z'),
          (33, ${migrationProjectId}, 3, 'Use the current search brief',
           ${JSON.stringify({ borough: "Brooklyn" })}::jsonb, 7, '2026-08-19T12:00:00Z'),
          (34, ${secondProjectId}, 1, 'Second project brief',
           ${JSON.stringify({ borough: "Queens" })}::jsonb, 11, '2026-08-20T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_projectinvitation
          (id, project_id, invited_email, role, inviter_id, token_digest, expires_at,
           accepted_at, revoked_at, created_at)
        values
          ('99999999-9999-4999-8999-999999999999', ${migrationProjectId},
           'invitee@example.test', 'viewer', 7, ${"a".repeat(64)}, '2026-09-10T12:00:00Z',
           null, null, '2026-08-20T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_searchrun
          (id, project_id, user_id, agent_token_id, agent_label, prompt_revision, prompt_snapshot,
           criteria_snapshot, status, lease_owner, lease_expires_at, claim_token, attempt_count,
           input_cursor, output_cursor, continuation, result_counts, summary, idempotency_key,
           created_at, started_at, completed_at, updated_at)
        values
          ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ${migrationProjectId}, 7,
           ${rotatedTokenId}, 'legacy-agent',
           3, 'Use the current search brief', ${JSON.stringify({ borough: "Brooklyn" })}::jsonb,
           'completed', '', null, '', 1, 'in', 'out', '{}'::jsonb,
           ${JSON.stringify({ created: 1 })}::jsonb, 'Completed intact', 'completed-key',
           '2026-08-20T12:00:00Z', '2026-08-20T12:01:00Z', '2026-08-20T12:02:00Z',
           '2026-08-20T12:02:00Z'),
          ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ${secondProjectId}, 11, null, 'stale-agent',
           1, 'Second project brief', ${JSON.stringify({ borough: "Queens" })}::jsonb,
           'running', 'old-worker', '2026-08-21T12:00:00Z', 'raw-claim', 2, '', '', '{}'::jsonb,
           '{}'::jsonb, 'Interrupted at cutover', 'unsafe-key', '2026-08-20T13:00:00Z',
           '2026-08-20T13:01:00Z', null, '2026-08-20T13:01:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_lead
          (id, project_id, source, source_listing_id, canonical_url, identity_hash, source_url,
           title, summary, location, price_display, price_amount, price_currency, availability,
           housing_type, date_confidence, park_notes, attributes, verification_notes, status,
           trashed_by_id, trashed_at, creator_id, revision, created_at, updated_at)
        values
          (${activeLeadId}, ${migrationProjectId}, 'fixture', 'listing-1',
           'https://EXAMPLE.test/place?utm_source=old&b=2&a=1', ${"b".repeat(64)}, '',
           'Active imported lead', 'Complete lead content', 'Brooklyn', '$1,500', 1500, 'USD',
           'September', 'shared', 'strong', '', ${JSON.stringify({ bedrooms: 2 })}::jsonb,
           'Verified', 'active', null, null, 7, 4, '2026-08-20T12:00:00Z',
           '2026-08-21T12:00:00Z'),
          (${trashedLeadId}, ${secondProjectId}, 'fixture', 'listing-2',
           'https://example.test/other', ${"c".repeat(64)}, 'https://example.test/source',
           'Trashed imported lead', '', 'Queens', '$1,200', 1200, 'USD', 'Now', 'entire',
           'verify', 'Near park', '{}'::jsonb, '', 'trashed', 11, '2026-08-22T12:00:00Z',
           11, 2, '2026-08-20T12:00:00Z', '2026-08-22T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_leadinterest (lead_id, user_id, created_at)
        values (${activeLeadId}, 9, '2026-08-21T13:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_leadcomment
          (id, lead_id, author_id, parent_id, body, created_at, edited_at, deleted_at)
        values
          (41, ${activeLeadId}, 9, null, 'Parent comment', '2026-08-21T14:00:00Z', null, null),
          (42, ${activeLeadId}, 11, 41, 'Reply from former user', '2026-08-21T15:00:00Z',
           '2026-08-21T16:00:00Z', null)
      `;
      await sqlClient`
        insert into django_source.projects_sourceplanreview
          (id, project_id, user_id, reporting_agent_token_id, resolving_agent_token_id, status,
           observed_prompt_revision, resolved_prompt_revision, opened_at, last_reported_at, resolved_at)
        values
          ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ${migrationProjectId}, 7,
           ${rotatedTokenId}, ${rotatedTokenId},
           'resolved', 2, 3, '2026-08-18T12:00:00Z', '2026-08-19T12:00:00Z',
           '2026-08-19T13:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_auditevent
          (id, project_id, action, object_type, object_id, actor_kind, actor_id, token_id,
           request_id, summary, created_at)
        values
          (51, ${migrationProjectId}, 'lead.updated', 'lead', ${activeLeadId}, 'user', 9,
           ${rotatedTokenId},
           'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ${JSON.stringify({ revision: 4 })}::jsonb,
           '2026-08-21T12:00:00Z')
      `;

      const sourceUrl = new URL(databaseUrl as string);
      sourceUrl.searchParams.set("options", "-csearch_path=django_source");
      const runScript = async (path: string, success = true) => {
        const child = spawn("bun", [path], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl as string,
            DJANGO_DATABASE_URL: sourceUrl.toString(),
            MIGRATION_CUTOVER_AT: "2026-08-25T04:00:00Z",
            PUBLIC_ORIGIN: "http://127.0.0.1:8000",
            AUTH_THROTTLE_KEY: "homing-migration-integration-test-key",
            NODE_ENV: "test",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        const [exitCode] = (await once(child, "close")) as [number | null];
        expect(exitCode === 0, stderr.slice(-2_000)).toBe(success);
        expect(`${stdout}\n${stderr}`).not.toContain(argon2Fixture);
        expect(`${stdout}\n${stderr}`).not.toContain(pbkdf2Fixture);
        return { stdout, stderr };
      };

      await sqlClient`
        insert into auth_throttles
          (key_digest, failure_count, window_started_at, updated_at)
        values (${"f".repeat(64)}, 0, now(), now())
      `;
      const nonemptyTarget = await runScript("src/server/db/import-django.ts", false);
      expect(nonemptyTarget.stderr).toContain(
        "Every target application table must be empty before the Django import",
      );
      await sqlClient`delete from auth_throttles where key_digest = ${"f".repeat(64)}`;

      const imported = await runScript("src/server/db/import-django.ts");
      expect(imported.stdout).toContain('"event":"source_password_support"');
      expect(imported.stdout).toContain('"event":"migration_complete"');
      expect(imported.stdout).not.toContain("migration-session-marker");
      expect(imported.stdout).not.toContain(rotatedTokenId);
      const migrationEvent = imported.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.event === "migration_complete");
      expect(migrationEvent?.authority_rotation).toEqual({
        active_runs_cancelled: 1,
        agent_links: 1,
        agent_tokens: 1,
        auth_throttles: 1,
        browser_sessions: 1,
        idempotency_keys: 1,
        pending_invitations_reissue: 1,
        project_changes: 1,
      });
      const [state] = await sqlClient<
        Array<{
          audit_total: string;
          cancelled_run_total: string;
          change_total: string;
          comment_total: string;
          invitation_total: string;
          invitation_rotated: boolean;
          interest_total: string;
          idempotency_total: string;
          identity_recomputed: boolean;
          json_exact: boolean;
          lead_total: string;
          link_total: string;
          live_claim_total: string;
          migration_total: string;
          pending_invitation_total: string;
          project_total: string;
          review_total: string;
          run_total: string;
          saved_prompt_total: string;
          session_total: string;
          timestamp_exact: boolean;
          throttle_total: string;
          token_reference_total: string;
          token_total: string;
          user_total: string;
        }>
      >`
        select
          (select count(*)::text from users) as user_total,
          (select count(*)::text from projects) as project_total,
          (select count(*)::text from saved_prompts) as saved_prompt_total,
          (select count(*)::text from project_invitations) as invitation_total,
          (select token_digest = 'legacy:99999999999949998999999999999999' and
                  revoked_at = '2026-08-25T04:00:00Z'::timestamptz
             from project_invitations where id = '99999999-9999-4999-8999-999999999999')
            as invitation_rotated,
          (select count(*)::text from project_invitations
            where accepted_at is null and revoked_at is null and expires_at > '2026-08-25T04:00:00Z')
            as pending_invitation_total,
          (select count(*)::text from search_runs) as run_total,
          (select count(*)::text from search_runs where status = 'cancelled') as cancelled_run_total,
          (select count(*)::text from search_runs
            where token_id is not null or claim_token_digest <> '' or lease_owner <> '' or
                  lease_expires_at is not null or idempotency_key <> '') as live_claim_total,
          (select count(*)::text from leads) as lead_total,
          (select count(*)::text from lead_interests) as interest_total,
          (select count(*)::text from lead_comments) as comment_total,
          (select count(*)::text from source_plan_reviews) as review_total,
          (select count(*)::text from audit_events) as audit_total,
          (select count(*)::text from agent_tokens) as token_total,
          (select count(*)::text from agent_links) as link_total,
          (select count(*)::text from auth_throttles) as throttle_total,
          (select count(*)::text from sessions) as session_total,
          (select count(*)::text from idempotency_keys) as idempotency_total,
          ((select count(*) from search_runs where token_id is not null) +
          (select count(*) from source_plan_reviews
            where reported_by_token_id is not null or resolved_by_token_id is not null) +
          (select count(*) from audit_events where token_id is not null))::text
            as token_reference_total,
          (select count(*)::text from project_changes) as change_total,
          (select count(*)::text from migration_records) as migration_total,
          (select personal_details::text from profiles where user_id = 7) =
          (select personal_details::text from django_source.accounts_profile where user_id = 7)
            as json_exact,
          (select updated_at from profiles where user_id = 7) =
          (select updated_at from django_source.accounts_profile where user_id = 7)
            as timestamp_exact,
          (select identity_hash from leads where id = ${activeLeadId}) =
          ${createHash("sha256")
            .update("https://example.test/place?a=1&b=2")
            .digest("hex")} as identity_recomputed
      `;
      expect(state).toEqual({
        audit_total: "1",
        cancelled_run_total: "1",
        change_total: "0",
        comment_total: "2",
        invitation_total: "1",
        invitation_rotated: true,
        interest_total: "1",
        idempotency_total: "0",
        identity_recomputed: true,
        json_exact: true,
        lead_total: "2",
        link_total: "0",
        live_claim_total: "0",
        migration_total: "2",
        pending_invitation_total: "0",
        project_total: "2",
        review_total: "1",
        run_total: "2",
        saved_prompt_total: "1",
        session_total: "0",
        timestamp_exact: true,
        throttle_total: "0",
        token_reference_total: "0",
        token_total: "0",
        user_total: "3",
      });
      const [importedLogin] = await sqlClient<
        { password_hash: string; password_reset_required: boolean }[]
      >`
        select password_hash, password_reset_required from users where id = 9
      `;
      expect(importedLogin?.password_reset_required).toBe(false);
      expect(
        await verifyImportedPassword("fixture password", importedLogin?.password_hash ?? ""),
      ).toMatchObject({ valid: true });
      const validated = await runScript("src/server/db/validate-import.ts");
      expect(validated.stdout).toContain('"valid":true');

      const replayed = await runScript("src/server/db/import-django.ts");
      const checksum = imported.stdout.match(/"target_checksum":"([a-f0-9]{64})"/)?.[1];
      expect(checksum).toBeTruthy();
      expect(replayed.stdout).toContain(`"target_checksum":"${checksum}"`);

      await sqlClient`
        update projects set description = 'Target changed after import'
         where id = ${migrationProjectId}
      `;
      const targetChanged = await runScript("src/server/db/import-django.ts", false);
      expect(targetChanged.stderr).toContain("Target changed after the recorded import");
      await sqlClient`
        update projects set description = 'Current shared search'
         where id = ${migrationProjectId}
      `;

      await sqlClient`update users set password_reset_required = true where id = 7`;
      const loginMarkerChanged = await runScript("src/server/db/validate-import.ts", false);
      expect(loginMarkerChanged.stderr).toContain(
        "Password reset marker does not match runtime hash support",
      );
      await sqlClient`update users set password_reset_required = false where id = 7`;

      await sqlClient`
        update django_source.projects_project set description = 'Source changed after freeze'
         where id = ${migrationProjectId}
      `;
      const changed = await runScript("src/server/db/import-django.ts", false);
      expect(changed.stderr).toContain("Recorded import does not match the complete frozen source");
    } finally {
      await sqlClient`drop schema if exists django_source cascade`;
    }
  }, 30_000);

  it("runs the versioned Python client through the production adapters", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "homing-real-client-"));
    const password = "fixture password";
    await sqlClient`update users set password_hash = ${pbkdf2Fixture} where id = 1`;

    const port = await new Promise<number>((resolve, reject) => {
      const reservation = createServer();
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address();
        if (!address || typeof address === "string") {
          reservation.close();
          reject(new Error("Could not reserve a local port."));
          return;
        }
        reservation.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const outputLog: string[] = [];
    const serverLog: string[] = [];
    const redactions = new Set<string>();
    const scriptPath = join(workspace, "homing.py");
    const tokenPath = join(workspace, "token");
    const runDirectory = join(workspace, "run");
    const clientEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    Object.assign(clientEnvironment, {
      HOMING_TOKEN_STORE: "file",
      HOMING_TOKEN_FILE: tokenPath,
      HOMING_RUN_DIR: runDirectory,
      XDG_CONFIG_HOME: join(workspace, "xdg"),
    });
    const serverEnvironment = {
      ...clientEnvironment,
      DATABASE_URL: databaseUrl as string,
      PUBLIC_ORIGIN: origin,
      AUTH_THROTTLE_KEY: "homing-real-client-test-throttle-key",
      PORT: String(port),
      NODE_ENV: "test",
    };
    const serverProcess = spawn("bun", ["src/server/index.ts"], {
      cwd: process.cwd(),
      env: serverEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout.on("data", (chunk) => serverLog.push(String(chunk)));
    serverProcess.stderr.on("data", (chunk) => serverLog.push(String(chunk)));

    const runClient = async (...args: string[]) => {
      const child = spawn("python3", [scriptPath, ...args], {
        cwd: workspace,
        env: clientEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const [exitCode] = (await once(child, "close")) as [number | null];
      outputLog.push(stdout, stderr);
      const safeDiagnostics = [...redactions].reduce(
        (text, value) => text.replaceAll(value, "[redacted]"),
        `${stderr}\n${serverLog.join("\n")}`,
      );
      expect(exitCode, `${args[0] ?? "client"} failed: ${safeDiagnostics.slice(-2_000)}`).toBe(0);
      return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    };

    try {
      const kit = buildKitPackage(origin);
      const script = kit.files.get("homing.py");
      expect(script).toBeTruthy();
      await writeFile(scriptPath, script as Uint8Array);
      await chmod(scriptPath, 0o700);

      let ready = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          const response = await fetch(`${origin}/health/ready`);
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          // The Bun server is still starting.
        }
        await delay(50);
      }
      expect(ready, "The production server did not become ready.").toBe(true);

      const pairingPath = join(workspace, "pairing.json");
      const devicePath = join(workspace, "device-code");
      const resultPath = join(workspace, "pair-result.json");
      const pairing = await runClient(
        "pair-request",
        "--label",
        "Postgres real-client test",
        "--out",
        pairingPath,
        "--device-code-out",
        devicePath,
      );
      const deviceCode = (await readFile(devicePath, "utf8")).trim();
      redactions.add(deviceCode);
      expect((await stat(devicePath)).mode & 0o077).toBe(0);

      const csrfResponse = await fetch(`${origin}/api/v1/csrf`);
      const csrfBody = (await csrfResponse.json()) as { csrf_token: string };
      let cookie = (csrfResponse.headers.get("set-cookie") ?? "").split(";", 1)[0] as string;
      const loginResponse = await fetch(`${origin}/api/v1/session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": csrfBody.csrf_token,
        },
        body: JSON.stringify({ email: "one@example.test", password }),
      });
      expect(loginResponse.status).toBe(200);
      const loginBody = (await loginResponse.json()) as { csrf_token: string };
      cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";", 1)[0] as string;
      const approval = await fetch(
        `${origin}/api/v1/auth/agent-links/${String(pairing.user_code)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: origin,
            "X-CSRF-Token": loginBody.csrf_token,
          },
          body: JSON.stringify({ action: "approve" }),
        },
      );
      expect(approval.status).toBe(200);

      const pairResult = await runClient(
        "pair-poll",
        "--device-code-file",
        devicePath,
        "--store",
        "--result",
        resultPath,
        "--timeout",
        "10",
        "--interval",
        "1",
      );
      expect(pairResult).toMatchObject({ paired: true, stored: true, verified: true });
      const rawToken = (await readFile(tokenPath, "utf8")).trim();
      redactions.add(rawToken);
      expect((await stat(tokenPath)).mode & 0o077).toBe(0);
      expect(outputLog.join("\n")).not.toContain(deviceCode);
      expect(outputLog.join("\n")).not.toContain(rawToken);
      expect(serverLog.join("\n")).not.toContain(deviceCode);
      expect(serverLog.join("\n")).not.toContain(rawToken);

      const projects = await runClient("projects");
      expect(projects).toMatchObject({ count: 1, projects: [{ id: projectId }] });
      expect(projects).not.toHaveProperty("paused");
      expect(projects).not.toHaveProperty("paused_until");
      const cursorPath = join(workspace, "cursor");
      const initialChanges = await runClient(
        "changes",
        "--project",
        projectId,
        "--cursor-file",
        cursorPath,
      );
      expect(initialChanges.next_cursor).toBe("testepoch:0");

      const createdRun = await runClient(
        "run-create",
        "--project",
        projectId,
        "--agent-label",
        "postgres/real-client",
        "--input-cursor",
        "testepoch:0",
        "--idempotency-key",
        "real-client-create",
      );
      const runId = String(createdRun.run_id);
      const claimed = await runClient("run-claim", "--project", projectId, "--run", runId);
      expect(claimed.claimed).toBe(true);

      const leadsPath = join(workspace, "leads.json");
      await writeFile(
        leadsPath,
        JSON.stringify({
          items: [
            {
              source: "real-client",
              source_listing_id: "x".repeat(300),
              url: "https://example.test/real-client",
              title: "Real client lead",
              price_display: "p".repeat(200),
              observed_at: "2026-08-20T16:00:00",
            },
          ],
        }),
      );
      const upserted = await runClient(
        "leads-upsert",
        "--project",
        projectId,
        "--items-file",
        leadsPath,
        "--run-id",
        runId,
      );
      expect(upserted).toMatchObject({ counts: { created: 1, errors: 0, verify_failed: 0 } });
      const [lead] = await sqlClient<Array<{ id: string }>>`
        select id from leads where project_id = ${projectId} and source = 'real-client'
      `;
      expect(lead?.id).toBeTruthy();
      const commentPath = join(workspace, "comment.txt");
      await writeFile(commentPath, "Seen by the real client.");
      expect(
        await runClient(
          "comment-add",
          "--project",
          projectId,
          "--lead",
          String(lead?.id),
          "--body-file",
          commentPath,
        ),
      ).toMatchObject({ ok: true });

      const completionPath = join(workspace, "completion.json");
      await writeFile(
        completionPath,
        JSON.stringify({
          output_cursor: "testepoch:4",
          continuation: { protocol: 1, lanes: [], deferred_batches: 0 },
          result_counts: { created: 1, trashed: 0, restored: 0 },
          summary: "Real-client integration complete.",
        }),
      );
      expect(
        await runClient(
          "run-complete",
          "--project",
          projectId,
          "--run",
          runId,
          "--payload-file",
          completionPath,
        ),
      ).toMatchObject({ ok: true, status: "completed" });

      const changed = await runClient(
        "changes",
        "--project",
        projectId,
        "--cursor-file",
        cursorPath,
      );
      expect((changed.items as unknown[]).length).toBeGreaterThan(0);
      await writeFile(cursorPath, "999");
      const reset = await runClient("changes", "--project", projectId, "--cursor-file", cursorPath);
      expect(reset).toMatchObject({ cursor_expired: true, state_reset: 1 });
      expect((await readFile(cursorPath, "utf8")).startsWith("testepoch:")).toBe(true);

      await collaboration.transaction((transaction) =>
        transaction.updatePrompt(projectId, 1, "Find the repaired fit", { city: "Queens" }, 1),
      );
      const reported = await runClient(
        "source-review-report",
        "--project",
        projectId,
        "--prompt-revision",
        "2",
      );
      const review = reported.review as { id: string };
      expect(await runClient("source-reviews")).toMatchObject({ count: 1 });
      expect(
        await runClient(
          "source-review-resolve",
          "--project",
          projectId,
          "--review",
          review.id,
          "--prompt-revision",
          "2",
        ),
      ).toMatchObject({ review: { status: "resolved" } });
    } finally {
      if (serverProcess.exitCode === null) {
        serverProcess.kill("SIGTERM");
        await Promise.race([once(serverProcess, "exit"), delay(2_000)]);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30_000);
});
