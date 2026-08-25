import { spawn } from "node:child_process";
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
import { DrizzleAuthRepository } from "../../src/server/auth/drizzle-repository";
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
    collaboration = new PostgresCollaborationRepository(
      database as ConstructorParameters<typeof PostgresCollaborationRepository>[0],
    );
    auth = new DrizzleAuthRepository(
      database as ConstructorParameters<typeof DrizzleAuthRepository>[0],
    );
  });

  beforeEach(async () => {
    await sqlClient`truncate table migration_records, users restart identity cascade`;
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

  it("imports the frozen Django project transactionally and validates fresh credential state", async () => {
    const migrationProjectId = "55555555-5555-4555-8555-555555555555";
    await sqlClient`truncate table migration_records, users restart identity cascade`;
    await sqlClient`drop schema if exists django_source cascade`;
    await sqlClient`create schema django_source`;
    try {
      await sqlClient`
        create table django_source.accounts_user (
          id bigint primary key,
          email varchar(254) not null,
          password text not null,
          is_active boolean not null,
          date_joined timestamptz not null,
          updated_at timestamptz not null
        )
      `;
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
          project_id uuid not null,
          revision integer not null,
          prompt text not null,
          criteria jsonb not null,
          editor_id bigint not null,
          created_at timestamptz not null
        )
      `;
      await sqlClient`
        insert into django_source.accounts_user
          (id, email, password, is_active, date_joined, updated_at)
        values
          (7, 'HART@example.test', ${argon2Fixture}, true,
           '2026-08-01T12:00:00Z', '2026-08-19T12:00:00Z'),
          (9, 'partner@example.test', ${pbkdf2Fixture}, true,
           '2026-08-02T12:00:00Z', '2026-08-19T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.accounts_profile
          (user_id, display_name, timezone, bio, personal_details, agent_paused_until, updated_at)
        values
          (7, 'Hart', 'America/New_York', 'Builder',
           ${JSON.stringify({ housing: "current" })}::jsonb, null, '2026-08-19T12:00:00Z'),
          (9, 'Partner', 'America/New_York', '', '{}'::jsonb,
           '2026-08-22T12:00:00Z', '2026-08-19T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_project
          (id, name, slug, description, prompt, criteria, status, prompt_revision, creator_id,
           created_at, updated_at)
        values
          (${migrationProjectId}, 'Imported Homing', 'imported-homing', 'Current shared search',
           'Use the current search brief', ${JSON.stringify({ borough: "Brooklyn" })}::jsonb,
           'active', 3, 7, '2026-08-03T12:00:00Z', '2026-08-19T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_projectmembership
          (project_id, user_id, role, joined_at)
        values
          (${migrationProjectId}, 7, 'owner', '2026-08-03T12:00:00Z'),
          (${migrationProjectId}, 9, 'editor', '2026-08-04T12:00:00Z')
      `;
      await sqlClient`
        insert into django_source.projects_promptrevision
          (project_id, revision, prompt, criteria, editor_id, created_at)
        values
          (${migrationProjectId}, 3, 'Use the current search brief',
           ${JSON.stringify({ borough: "Brooklyn" })}::jsonb, 7, '2026-08-19T12:00:00Z')
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
            MIGRATE_PROJECT_ID: migrationProjectId,
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

      const imported = await runScript("src/server/db/import-django.ts");
      expect(imported.stdout).toContain('"event":"source_password_algorithms"');
      expect(imported.stdout).toContain('"event":"migration_complete"');
      const [state] = await sqlClient<
        Array<{
          change_total: string;
          feed_epoch: string;
          latest_change_sequence: string;
          member_total: string;
          profile_total: string;
          token_total: string;
          user_ids: string[];
        }>
      >`
        select project.feed_epoch,
               project.latest_change_sequence::text,
               (select count(*)::text from project_changes where project_id = project.id) as change_total,
               (select count(*)::text from project_memberships where project_id = project.id) as member_total,
               (select count(*)::text from profiles profile
                 join project_memberships member on member.user_id = profile.user_id
                where member.project_id = project.id) as profile_total,
               (select count(*)::text from agent_tokens) as token_total,
               (select array_agg(member.user_id order by member.user_id)
                  from project_memberships member where member.project_id = project.id) as user_ids
          from projects project
         where project.id = ${migrationProjectId}
      `;
      expect(state).toEqual({
        change_total: "0",
        feed_epoch: expect.stringMatching(/^[a-f0-9]{32}$/),
        latest_change_sequence: "0",
        member_total: "2",
        profile_total: "2",
        token_total: "0",
        user_ids: ["7", "9"],
      });
      const validated = await runScript("src/server/db/validate-import.ts");
      expect(validated.stdout).toContain('"valid":true');

      const replayed = await runScript("src/server/db/import-django.ts");
      const checksum = imported.stdout.match(/"target_checksum":"([a-f0-9]{64})"/)?.[1];
      expect(checksum).toBeTruthy();
      expect(replayed.stdout).toContain(`"target_checksum":"${checksum}"`);

      await sqlClient`
        update django_source.projects_project set prompt = 'Source changed after freeze'
         where id = ${migrationProjectId}
      `;
      const changed = await runScript("src/server/db/import-django.ts", false);
      expect(changed.stderr).toContain("Source changed after the recorded import");
    } finally {
      await sqlClient`drop schema if exists django_source cascade`;
    }
  }, 30_000);

  it("runs the unchanged Python client through the production adapters", async () => {
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
      const script = kit.files.get("scripts/homing.py");
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
