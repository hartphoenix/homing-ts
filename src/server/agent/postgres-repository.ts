import { randomBytes, randomUUID } from "node:crypto";

import type postgres from "postgres";

import { getSqlClient } from "../db/client";
import { type ChangeRepository, ChangeService, type ProjectChange } from "./changes";
import { conflict, notFound } from "./errors";
import {
  type AgentPrincipal,
  decodeRunCursor,
  digest,
  encodeRunCursor,
  type ProjectAuthorizer,
  type ProjectSnapshot,
  type RunCompletion,
  type RunCreateRequest,
  type RunListOptions,
  type RunRepository,
  RunService,
  type SearchRun,
  serializeRun,
} from "./runs";
import {
  type SourcePlanRepository,
  type SourcePlanReview,
  SourcePlanService,
} from "./source-plans";

type SqlClient = ReturnType<typeof getSqlClient>;
type SqlTransaction = postgres.TransactionSql;
type SqlExecutor = SqlClient | SqlTransaction;
type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function optionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function iso(value: Date): string {
  return value.toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function countObject(value: unknown): Record<string, number> {
  const object = jsonObject(value);
  return Object.fromEntries(
    Object.entries(object).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function mapRun(row: Row): SearchRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    userId: Number(row.user_id),
    tokenId: row.token_id === null || row.token_id === undefined ? null : String(row.token_id),
    agentLabel: String(row.agent_label),
    promptRevision: Number(row.prompt_revision),
    promptSnapshot: String(row.prompt_snapshot),
    criteriaSnapshot: jsonObject(row.criteria_snapshot),
    status: row.status as SearchRun["status"],
    leaseOwner: String(row.lease_owner),
    leaseExpiresAt: optionalDate(row.lease_expires_at),
    claimTokenDigest: String(row.claim_token_digest ?? ""),
    attemptCount: Number(row.attempt_count),
    inputCursor: String(row.input_cursor),
    outputCursor: String(row.output_cursor),
    continuation: jsonObject(row.continuation),
    resultCounts: countObject(row.result_counts),
    summary: String(row.summary),
    idempotencyKey: String(row.idempotency_key),
    createdAt: date(row.created_at),
    completedAt: optionalDate(row.completed_at),
  };
}

function mapReview(row: Row): SourcePlanReview {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    userId: Number(row.user_id),
    status: row.status as SourcePlanReview["status"],
    observedPromptRevision: Number(row.observed_prompt_revision),
    resolvedPromptRevision:
      row.resolved_prompt_revision === null || row.resolved_prompt_revision === undefined
        ? null
        : Number(row.resolved_prompt_revision),
    openedAt: date(row.opened_at),
    lastReportedAt: date(row.last_reported_at),
    resolvedAt: optionalDate(row.resolved_at),
  };
}

async function appendChange(
  sql: SqlExecutor,
  projectId: string,
  eventType: string,
  objectType: string,
  objectId: string,
  payload: Record<string, unknown>,
  principal: AgentPrincipal,
): Promise<void> {
  const rows = await sql<Row[]>`
    update projects
       set latest_change_sequence = latest_change_sequence + 1,
           updated_at = now()
     where id = ${projectId}
     returning latest_change_sequence
  `;
  const sequence = rows[0]?.latest_change_sequence;
  if (sequence === undefined) throw notFound();
  await sql`
    insert into project_changes
      (project_id, sequence, event_type, object_type, object_id, payload,
       tombstone, actor_id, actor_kind, token_id)
    values
      (${projectId}, ${String(sequence)}, ${eventType}, ${objectType}, ${objectId},
       ${jsonText(payload)}::jsonb, false, ${principal.userId},
       ${principal.tokenId ? "agent" : "user"}, ${principal.tokenId ?? null})
  `;
}

async function audit(
  sql: SqlExecutor,
  action: string,
  projectId: string,
  objectId: string,
  principal: AgentPrincipal,
  summary: Record<string, unknown>,
): Promise<void> {
  await sql`
    insert into audit_events
      (project_id, action, object_type, object_id, actor_kind, actor_id, token_id, summary)
    values
      (${projectId}, ${action}, 'source_plan_review', ${objectId},
       ${principal.tokenId ? "agent" : "user"}, ${principal.userId},
       ${principal.tokenId ?? null}, ${jsonText(summary)}::jsonb)
  `;
}

type IdempotencyRow = {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
};

async function idempotency(
  sql: SqlExecutor,
  principal: AgentPrincipal,
  endpoint: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const rows = await sql<IdempotencyRow[]>`
    select request_hash, response_status, response_body
      from idempotency_keys
     where user_id = ${principal.userId}
       and token_id is not distinct from ${principal.tokenId ?? null}
       and endpoint = ${endpoint}
       and key = ${key}
       and expires_at > now()
     for update
  `;
  return rows[0] ?? null;
}

async function clearExpiredIdempotency(
  sql: SqlExecutor,
  principal: AgentPrincipal,
  endpoint: string,
  key: string,
): Promise<void> {
  await sql`
    delete from idempotency_keys
     where user_id = ${principal.userId}
       and token_id is not distinct from ${principal.tokenId ?? null}
       and endpoint = ${endpoint}
       and key = ${key}
       and expires_at <= now()
  `;
}

async function storeIdempotency(
  sql: SqlExecutor,
  principal: AgentPrincipal,
  endpoint: string,
  key: string,
  requestHash: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await sql`
    insert into idempotency_keys
      (user_id, token_id, endpoint, key, request_hash, response_status, response_body, expires_at)
    values
      (${principal.userId}, ${principal.tokenId ?? null}, ${endpoint}, ${key}, ${requestHash},
       ${responseStatus}, ${jsonText(responseBody)}::jsonb, now() + interval '7 days')
  `;
}

export class PostgresAgentRepository
  implements RunRepository, ChangeRepository, SourcePlanRepository
{
  constructor(private readonly sql: SqlClient = getSqlClient()) {}

  async snapshotProject(projectId: string): Promise<ProjectSnapshot | null> {
    const rows = await this.sql<Row[]>`
      select id, prompt_revision, current_prompt, criteria, feed_epoch
        from projects
       where id = ${projectId} and status = 'active'
    `;
    const row = rows[0];
    return row
      ? {
          id: String(row.id),
          promptRevision: Number(row.prompt_revision),
          promptSnapshot: String(row.current_prompt),
          criteriaSnapshot: jsonObject(row.criteria),
          feedEpoch: String(row.feed_epoch),
        }
      : null;
  }

  async create(request: RunCreateRequest): Promise<{ run: SearchRun; replayed: boolean }> {
    return this.sql.begin(async (sql) => {
      const projectRows = await sql<Row[]>`
        select id, prompt_revision, current_prompt, criteria
          from projects
         where id = ${request.projectId} and status = 'active'
         for update
      `;
      const project = projectRows[0];
      if (!project) throw notFound();

      const principal: AgentPrincipal = {
        userId: request.userId,
        tokenId: request.tokenId,
      };
      const endpoint = `/projects/${request.projectId}/search-runs`;
      const requestHash = digest({
        agent_label: request.agentLabel,
        input_cursor: request.inputCursor,
        continuation_from_run_id: request.continuationFromRunId ?? null,
      });
      if (request.idempotencyKey) {
        await clearExpiredIdempotency(sql, principal, endpoint, request.idempotencyKey);
        const prior = await idempotency(sql, principal, endpoint, request.idempotencyKey);
        if (prior) {
          if (prior.request_hash !== requestHash) {
            throw conflict(
              "idempotency_key_reused",
              "The idempotency key was already used with a different request.",
            );
          }
          const priorId = jsonObject(prior.response_body).id;
          const priorRows = await sql<
            Row[]
          >`select * from search_runs where id = ${String(priorId)}`;
          if (!priorRows[0])
            throw conflict(
              "idempotency_replay_unavailable",
              "The stored response is no longer available.",
            );
          return { run: mapRun(priorRows[0]), replayed: true };
        }
      }

      const rows = await sql<Row[]>`
        insert into search_runs
          (project_id, user_id, token_id, agent_label, prompt_revision, prompt_snapshot,
           criteria_snapshot, input_cursor, idempotency_key)
        values
          (${request.projectId}, ${request.userId}, ${request.tokenId}, ${request.agentLabel},
           ${Number(project.prompt_revision)}, ${String(project.current_prompt)},
           ${jsonText(jsonObject(project.criteria))}::jsonb, ${request.inputCursor}, '')
        returning *
      `;
      const run = mapRun(rows[0] as Row);
      await appendChange(
        sql,
        request.projectId,
        "run.created",
        "search_run",
        run.id,
        { status: run.status, prompt_revision: run.promptRevision },
        principal,
      );
      if (request.idempotencyKey) {
        await storeIdempotency(
          sql,
          principal,
          endpoint,
          request.idempotencyKey,
          requestHash,
          201,
          serializeRun(run),
        );
      }
      return { run, replayed: false };
    });
  }

  async get(projectId: string, runId: string): Promise<SearchRun | null> {
    const rows = await this.sql<Row[]>`
      select * from search_runs where project_id = ${projectId} and id = ${runId}
    `;
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async claim(
    projectId: string,
    runId: string,
    principal: AgentPrincipal,
    now: Date,
  ): Promise<{ run: SearchRun; claimToken: string }> {
    return this.sql.begin(async (sql) => {
      const project = await sql<Row[]>`select id from projects where id = ${projectId} for update`;
      if (!project[0]) throw notFound();
      const rows = await sql<Row[]>`
        select * from search_runs where project_id = ${projectId} and id = ${runId} for update
      `;
      if (!rows[0]) throw notFound();
      const run = mapRun(rows[0]);
      if (
        (run.status === "claimed" || run.status === "running") &&
        run.leaseExpiresAt &&
        run.leaseExpiresAt > now
      ) {
        throw conflict("run_already_claimed", "This run already holds the project lease.");
      }
      const active = await sql<Row[]>`
        select id from search_runs
         where project_id = ${projectId}
           and id <> ${runId}
           and status in ('claimed', 'running')
           and lease_expires_at > ${iso(now)}
         limit 1
      `;
      if (active[0]) throw conflict("run_already_claimed", "Another run holds the project lease.");
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        throw conflict("run_not_claimable", "Run is already finished.");
      }
      const claimToken = randomBytes(32).toString("base64url");
      const updated = await sql<Row[]>`
        update search_runs
           set status = 'claimed',
               lease_owner = ${`${principal.userId}:${principal.tokenId ?? "session"}`},
               lease_expires_at = ${iso(new Date(now.getTime() + 5 * 60_000))},
               claim_token_digest = ${digest(claimToken)},
               attempt_count = attempt_count + 1,
               updated_at = ${iso(now)}
         where id = ${runId}
         returning *
      `;
      const claimed = mapRun(updated[0] as Row);
      await appendChange(
        sql,
        projectId,
        "run.claimed",
        "search_run",
        runId,
        { status: claimed.status, attempt_count: claimed.attemptCount },
        principal,
      );
      return { run: claimed, claimToken };
    });
  }

  async heartbeat(
    projectId: string,
    runId: string,
    principal: AgentPrincipal,
    claimToken: string,
    now: Date,
  ): Promise<SearchRun> {
    return this.sql.begin(async (sql) => {
      const project = await sql<Row[]>`select id from projects where id = ${projectId} for update`;
      if (!project[0]) throw notFound();
      const rows = await sql<Row[]>`
        select * from search_runs where project_id = ${projectId} and id = ${runId} for update
      `;
      const row = rows[0];
      if (!row) throw notFound();
      const run = mapRun(row);
      if (
        run.claimTokenDigest !== digest(claimToken) ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now
      ) {
        throw conflict("invalid_claim", "Claim token is invalid or expired.");
      }
      const updated = await sql<Row[]>`
        update search_runs
           set status = 'running', lease_expires_at = ${iso(new Date(now.getTime() + 5 * 60_000))},
               updated_at = ${iso(now)}
         where id = ${runId}
         returning *
      `;
      const heartbeat = mapRun(updated[0] as Row);
      await appendChange(
        sql,
        projectId,
        "run.heartbeat",
        "search_run",
        runId,
        { status: heartbeat.status },
        principal,
      );
      return heartbeat;
    });
  }

  async complete(
    projectId: string,
    runId: string,
    principal: AgentPrincipal,
    completion: RunCompletion,
    now: Date,
  ): Promise<{ run: SearchRun; replayed: boolean }> {
    return this.sql.begin(async (sql) => {
      const project = await sql<Row[]>`select id from projects where id = ${projectId} for update`;
      if (!project[0]) throw notFound();
      const rows = await sql<Row[]>`
        select * from search_runs where project_id = ${projectId} and id = ${runId} for update
      `;
      if (!rows[0]) throw notFound();
      const run = mapRun(rows[0]);
      const endpoint = `/projects/${projectId}/search-runs/${runId}/complete`;
      const requestHash = digest(completion);
      await clearExpiredIdempotency(sql, principal, endpoint, completion.idempotencyKey);
      const prior = await idempotency(sql, principal, endpoint, completion.idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw conflict(
            "idempotency_key_reused",
            "The idempotency key was already used with a different request.",
          );
        }
        return { run, replayed: true };
      }

      if (run.status === "completed" || run.status === "failed") {
        throw conflict("invalid_claim", "Claim token is invalid or expired.");
      }
      if (
        run.claimTokenDigest !== digest(completion.claimToken) ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now
      ) {
        throw conflict("invalid_claim", "Claim token is invalid or expired.");
      }
      const updated = await sql<Row[]>`
        update search_runs
           set status = ${completion.status}, output_cursor = ${completion.outputCursor},
               continuation = ${jsonText(completion.continuation)}::jsonb,
               result_counts = ${jsonText(completion.resultCounts)}::jsonb, summary = ${completion.summary},
               completed_at = ${iso(now)}, lease_expires_at = null, updated_at = ${iso(now)}
         where id = ${runId}
         returning *
      `;
      const completed = mapRun(updated[0] as Row);
      await appendChange(
        sql,
        projectId,
        "run.completed",
        "search_run",
        runId,
        { status: completed.status },
        principal,
      );
      await storeIdempotency(
        sql,
        principal,
        endpoint,
        completion.idempotencyKey,
        requestHash,
        200,
        serializeRun(completed),
      );
      return { run: completed, replayed: false };
    });
  }

  async feedEpoch(projectId: string): Promise<string | null> {
    const rows = await this.sql<Row[]>`
      select feed_epoch from projects where id = ${projectId} and status = 'active'
    `;
    return rows[0] ? String(rows[0].feed_epoch) : null;
  }

  async listChanges(projectId: string, after: bigint, limit: number): Promise<ProjectChange[]> {
    const rows = await this.sql<Row[]>`
      select sequence, event_type, object_type, object_id, payload, tombstone, occurred_at
        from project_changes
       where project_id = ${projectId} and sequence > ${after.toString()}
       order by sequence
       limit ${limit}
    `;
    return rows.map((row) => ({
      sequence: BigInt(String(row.sequence)),
      eventType: String(row.event_type),
      objectType: String(row.object_type),
      objectId: String(row.object_id),
      payload: jsonObject(row.payload),
      tombstone: Boolean(row.tombstone),
      occurredAt: date(row.occurred_at),
    }));
  }

  // The distinct name avoids colliding with RunRepository.list at runtime.
  async list(
    projectId: string,
    options: RunListOptions,
    principal: AgentPrincipal,
  ): Promise<{ runs: SearchRun[]; nextCursor: string | null }>;
  async list(
    projectId: string,
    after: bigint,
    limit: number,
    principal: AgentPrincipal,
  ): Promise<ProjectChange[]>;
  async list(
    projectId: string,
    afterOrOptions: bigint | RunListOptions,
    limitOrPrincipal: number | AgentPrincipal,
    _principal?: AgentPrincipal,
  ): Promise<ProjectChange[] | { runs: SearchRun[]; nextCursor: string | null }> {
    if (typeof afterOrOptions === "bigint") {
      return this.listChanges(projectId, afterOrOptions, limitOrPrincipal as number);
    }
    return this.listRuns(projectId, afterOrOptions);
  }

  private async listRuns(projectId: string, options: RunListOptions) {
    const cursor = options.cursor ? decodeRunCursor(options.cursor) : null;
    let rows: Row[];
    if (cursor && options.agentLabelPrefix) {
      rows = await this.sql<Row[]>`
        select * from search_runs
         where project_id = ${projectId}
           and left(agent_label, length(${options.agentLabelPrefix})) = ${options.agentLabelPrefix}
           and (created_at, id) < (${iso(cursor.createdAt)}, ${cursor.id})
         order by created_at desc, id desc limit ${options.limit + 1}
      `;
    } else if (cursor) {
      rows = await this.sql<Row[]>`
        select * from search_runs
         where project_id = ${projectId} and (created_at, id) < (${iso(cursor.createdAt)}, ${cursor.id})
         order by created_at desc, id desc limit ${options.limit + 1}
      `;
    } else if (options.agentLabelPrefix) {
      rows = await this.sql<Row[]>`
        select * from search_runs
         where project_id = ${projectId}
           and left(agent_label, length(${options.agentLabelPrefix})) = ${options.agentLabelPrefix}
         order by created_at desc, id desc limit ${options.limit + 1}
      `;
    } else {
      rows = await this.sql<Row[]>`
        select * from search_runs where project_id = ${projectId}
         order by created_at desc, id desc limit ${options.limit + 1}
      `;
    }
    const hasMore = rows.length > options.limit;
    const runs = rows.slice(0, options.limit).map(mapRun);
    return {
      runs,
      nextCursor:
        hasMore && runs.length ? encodeRunCursor(runs[runs.length - 1] as SearchRun) : null,
    };
  }

  async currentPromptRevision(projectId: string): Promise<number | null> {
    const rows = await this.sql<Row[]>`
      select prompt_revision from projects where id = ${projectId} and status = 'active'
    `;
    return rows[0] ? Number(rows[0].prompt_revision) : null;
  }

  async listOpen(userId: number): Promise<SourcePlanReview[]> {
    const rows = await this.sql<Row[]>`
      select review.*
        from source_plan_reviews review
        join projects project on project.id = review.project_id and project.status = 'active'
        join project_memberships membership
          on membership.project_id = review.project_id and membership.user_id = ${userId}
       where review.user_id = ${userId} and review.status = 'open'
       order by review.last_reported_at desc, review.id
       limit 100
    `;
    return rows.map(mapReview);
  }

  async open(
    projectId: string,
    userId: number,
    tokenId: string | null,
    promptRevision: number,
    now: Date,
  ): Promise<{ review: SourcePlanReview; created: boolean }> {
    return this.sql.begin(async (sql) => {
      const project = await sql<Row[]>`
        select prompt_revision from projects where id = ${projectId} and status = 'active' for update
      `;
      if (!project[0]) throw notFound();
      const current = Number(project[0].prompt_revision);
      if (current !== promptRevision) {
        throw conflict(
          "stale_prompt_revision",
          "The project prompt has changed; read it again before reporting.",
          {
            prompt_revision: [`current revision is ${current}`],
          },
        );
      }
      const existing = await sql<Row[]>`
        select * from source_plan_reviews
         where project_id = ${projectId} and user_id = ${userId} and status = 'open'
         for update
      `;
      const principal: AgentPrincipal = { userId, tokenId };
      if (existing[0]) {
        const rows = await sql<Row[]>`
          update source_plan_reviews
             set observed_prompt_revision = ${promptRevision}, last_reported_at = ${iso(now)},
                 reported_by_token_id = ${tokenId}
           where id = ${String(existing[0].id)}
           returning *
        `;
        await audit(
          sql,
          "source_plan_review.opened",
          projectId,
          String(existing[0].id),
          principal,
          {
            prompt_revision: promptRevision,
            refreshed: true,
          },
        );
        return { review: mapReview(rows[0] as Row), created: false };
      }
      const id = randomUUID();
      const rows = await sql<Row[]>`
        insert into source_plan_reviews
          (id, project_id, user_id, reported_by_token_id, status,
           observed_prompt_revision, opened_at, last_reported_at)
        values
          (${id}, ${projectId}, ${userId}, ${tokenId}, 'open', ${promptRevision}, ${iso(now)}, ${iso(now)})
        returning *
      `;
      await audit(sql, "source_plan_review.opened", projectId, id, principal, {
        prompt_revision: promptRevision,
        refreshed: false,
      });
      return { review: mapReview(rows[0] as Row), created: true };
    });
  }

  async find(
    projectId: string,
    reviewId: string,
    userId: number,
  ): Promise<SourcePlanReview | null> {
    const rows = await this.sql<Row[]>`
      select * from source_plan_reviews
       where id = ${reviewId} and project_id = ${projectId} and user_id = ${userId}
    `;
    return rows[0] ? mapReview(rows[0]) : null;
  }

  async resolve(
    review: SourcePlanReview,
    tokenId: string | null,
    promptRevision: number,
    now: Date,
  ): Promise<SourcePlanReview> {
    return this.sql.begin(async (sql) => {
      const project = await sql<Row[]>`
        select prompt_revision from projects where id = ${review.projectId} and status = 'active' for update
      `;
      if (!project[0]) throw notFound();
      const current = Number(project[0].prompt_revision);
      if (current !== promptRevision) {
        throw conflict(
          "stale_prompt_revision",
          "The project prompt has changed; read it again before resolving.",
          {
            prompt_revision: [`current revision is ${current}`],
          },
        );
      }
      const rows = await sql<Row[]>`
        select * from source_plan_reviews
         where id = ${review.id} and project_id = ${review.projectId} and user_id = ${review.userId}
         for update
      `;
      if (!rows[0]) throw notFound();
      const currentReview = mapReview(rows[0]);
      if (currentReview.status === "resolved") {
        if (currentReview.resolvedPromptRevision === promptRevision) return currentReview;
        throw conflict(
          "source_plan_review_stale",
          "Report the current prompt revision before resolving.",
        );
      }
      if (currentReview.observedPromptRevision !== current) {
        throw conflict(
          "source_plan_review_stale",
          "Report the current prompt revision before resolving.",
        );
      }
      const updated = await sql<Row[]>`
        update source_plan_reviews
           set status = 'resolved', resolved_prompt_revision = ${promptRevision}, resolved_at = ${iso(now)}
         where id = ${review.id}
         returning *
      `;
      await audit(
        sql,
        "source_plan_review.resolved",
        review.projectId,
        review.id,
        { userId: review.userId, tokenId },
        { prompt_revision: promptRevision },
      );
      return mapReview(updated[0] as Row);
    });
  }
}

/** Membership and active-project opacity shared by every private agent route. */
export function createPostgresProjectAuthorizer(
  sql: SqlClient = getSqlClient(),
): ProjectAuthorizer {
  return async (principal, projectId) => {
    const rows = await sql<Row[]>`
      select project.id
        from projects project
        join project_memberships membership
          on membership.project_id = project.id and membership.user_id = ${principal.userId}
       where project.id = ${projectId} and project.status = 'active'
    `;
    if (!rows[0]) throw notFound();
  };
}

/** The safe production composition keeps membership authorization non-optional. */
export function createPostgresAgentServices(sql: SqlClient = getSqlClient()) {
  const repository = new PostgresAgentRepository(sql);
  const authorize = createPostgresProjectAuthorizer(sql);
  return {
    repository,
    runs: new RunService(repository, authorize),
    changes: new ChangeService(repository, authorize),
    sourcePlans: new SourcePlanService(repository, authorize),
  };
}
