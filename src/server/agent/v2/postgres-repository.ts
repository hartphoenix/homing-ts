import { and, asc, eq, sql } from "drizzle-orm";
import { AGENT_SCOPE_SET, type AgentScope, V2_AGENT_SCOPE_SET } from "../../auth/scopes";
import type { AgentTokenRecord } from "../../auth/types";
import { getDatabase } from "../../db/client";
import {
  agentRunProjects,
  agentRunQueries,
  agentRuns,
  agentTokens,
  auditEvents,
  leads,
  matchObservations,
  profiles,
  projectChanges,
  projectMemberships,
  projects,
  promptRevisionSourceQueries,
  promptRevisions,
  sourceQueryRevisions,
} from "../../db/schema";
import { HomingError } from "../../http";
import { canonicalJsonBytes, canonicalJsonSha256 } from "./canonical";
import type {
  ConfigSourceQueryInput,
  CreateConfigInput,
  CreateRunInput,
  DeliverInput,
  DeliverResult,
  RunSnapshotProject,
  V2ConfigRevision,
  V2ProjectSummary,
  V2Repository,
  V2RunRecord,
  V2SourceQueryRevision,
} from "./repository";
import type { AgentRunReport, RunPhase, RunStatus } from "./schemas";

type Database = ReturnType<typeof getDatabase>;
type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function optionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("database returned a non-binary canonical payload");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function tokenScopes(value: string[]): AgentScope[] {
  return value.filter(
    (scope): scope is AgentScope => AGENT_SCOPE_SET.has(scope) || V2_AGENT_SCOPE_SET.has(scope),
  );
}

function tokenRecord(row: Row): AgentTokenRecord {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    name: String(row.name),
    tokenPrefix: String(row.token_prefix),
    digest: String(row.digest),
    scopes: tokenScopes(stringArray(row.scopes)),
    projectIds: stringArray(row.project_ids),
    expectedCadenceMinutes:
      row.expected_cadence_minutes === null || row.expected_cadence_minutes === undefined
        ? null
        : Number(row.expected_cadence_minutes),
    environmentNote: String(row.environment_note),
    exposedToChat: Boolean(row.exposed_to_chat),
    sourceWriteExpiresAt: optionalDate(row.source_write_expires_at),
    expiresAt: date(row.expires_at),
    revokedAt: optionalDate(row.revoked_at),
    lastUsedAt: optionalDate(row.last_used_at),
    createdAt: date(row.created_at),
  };
}

function runStatus(value: unknown): RunStatus {
  return String(value) as RunStatus;
}

function runPhase(value: unknown): RunPhase {
  return String(value) as RunPhase;
}

function mapReport(row: Row, queries: Row[]): AgentRunReport | null {
  const status = runStatus(row.status);
  if (status === "started") return null;
  return {
    status,
    phase: runPhase(row.phase),
    queries: queries.map((query) => ({
      source_query_revision_id: String(query.source_query_revision_id),
      status: String(query.status) as AgentRunReport["queries"][number]["status"],
      ...(query.error_class === null || query.error_class === undefined
        ? {}
        : { error_class: String(query.error_class) }),
    })),
    counts: {
      source_queries_total: queries.length,
      source_queries_attempted: Number(row.source_queries_attempted),
      source_queries_completed: Number(row.source_queries_completed),
      candidates_observed: Number(row.candidates_observed),
      candidates_evaluated: Number(row.candidates_evaluated),
      candidates_kept: Number(row.candidates_kept),
      candidates_insufficient: Number(row.candidates_insufficient),
      deliveries_acknowledged: Number(row.deliveries_acknowledged),
      deliveries_pending: Number(row.deliveries_pending),
    },
    failure:
      row.failure_code === null || row.failure_code === undefined
        ? null
        : { phase: runPhase(row.failure_phase), code: String(row.failure_code) },
  };
}

async function runProjects(db: Database, runId: string): Promise<RunSnapshotProject[]> {
  const projectRows = await db
    .select()
    .from(agentRunProjects)
    .where(eq(agentRunProjects.runId, runId))
    .orderBy(asc(agentRunProjects.projectId));
  const queryRows = await db
    .select()
    .from(agentRunQueries)
    .where(eq(agentRunQueries.runId, runId))
    .orderBy(asc(agentRunQueries.projectId), asc(agentRunQueries.sourceQueryRevision));
  return projectRows.map((project) => ({
    projectId: project.projectId,
    promptRevisionId: project.promptRevisionId,
    promptRevision: project.promptRevision,
    canonicalSha256: project.canonicalSha256,
    queries: queryRows
      .filter((query) => query.projectId === project.projectId)
      .map((query) => ({
        sourceQueryRevisionId: query.sourceQueryRevisionId,
        sourceQueryRevision: query.sourceQueryRevision,
        canonicalSha256: query.canonicalSha256,
      })),
  }));
}

async function mapRun(db: Database, row: Row): Promise<V2RunRecord> {
  const queries = await db
    .select()
    .from(agentRunQueries)
    .where(eq(agentRunQueries.runId, String(row.id)))
    .orderBy(asc(agentRunQueries.projectId), asc(agentRunQueries.sourceQueryRevision));
  return {
    id: String(row.id),
    invocationId: String(row.invocation_id),
    userId: Number(row.user_id),
    tokenId: String(row.token_id),
    agentLabel: String(row.agent_label),
    status: runStatus(row.status),
    phase: runPhase(row.phase),
    projects: await runProjects(db, String(row.id)),
    report: mapReport(row, queries),
  };
}

function conflict(message: string, fields: Record<string, unknown> = {}): never {
  throw new HomingError("conflict", message, 409, fields);
}

function notFound(): never {
  throw new HomingError("not_found", "Object not found.", 404);
}

function ensureHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid canonical SHA-256 digest");
  return value;
}

async function assertMembership(
  db: Database,
  userId: number,
  projectId: string,
  lock = false,
): Promise<Row> {
  const projectQuery = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.status, "active")))
    .limit(1);
  const projectRows = lock ? await projectQuery.for("update") : await projectQuery;
  const project = projectRows[0];
  if (!project) notFound();
  const [membership] = await db
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)))
    .limit(1);
  if (!membership) notFound();
  return project as Row;
}

function queryInputEqual(row: Row, input: ConfigSourceQueryInput): boolean {
  return (
    String(row.canonical_sha256) === input.canonicalSha256 &&
    bytes(row.canonical_bytes).every((value, index) => value === input.canonicalBytes[index]) &&
    bytes(row.canonical_bytes).byteLength === input.canonicalBytes.byteLength
  );
}

export class PostgresV2Repository implements V2Repository {
  constructor(private readonly db: Database = getDatabase()) {}

  async listProjects(userId: number): Promise<V2ProjectSummary[]> {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        configStatus: promptRevisions.configStatus,
        configRevision: promptRevisions.revision,
        configRevisionId: promptRevisions.id,
        pausedUntil: profiles.agentPausedUntil,
      })
      .from(projectMemberships)
      .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
      .innerJoin(profiles, eq(profiles.userId, userId))
      .leftJoin(promptRevisions, eq(promptRevisions.id, projects.currentConfigRevisionId))
      .where(and(eq(projectMemberships.userId, userId), eq(projects.status, "active")))
      .orderBy(asc(projects.name), asc(projects.id));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      configStatus: row.configStatus === "complete" ? "ready" : "needed",
      configRevision: row.configRevision ?? null,
      configRevisionId: row.configRevisionId ?? null,
      pausedUntil: row.pausedUntil ?? null,
    }));
  }

  async getConfigRevision(
    userId: number,
    projectId: string,
    revision: number,
  ): Promise<V2ConfigRevision | null> {
    const rows = await this.db
      .select({
        id: promptRevisions.id,
        projectId: promptRevisions.projectId,
        revision: promptRevisions.revision,
        status: promptRevisions.configStatus,
        canonicalBytes: promptRevisions.canonicalBytes,
        canonicalSha256: promptRevisions.canonicalSha256,
        requiredEvidence: promptRevisions.requiredEvidence,
      })
      .from(promptRevisions)
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.projectId, promptRevisions.projectId),
          eq(projectMemberships.userId, userId),
        ),
      )
      .where(
        and(
          eq(promptRevisions.projectId, projectId),
          eq(promptRevisions.revision, revision),
          eq(promptRevisions.configStatus, "complete"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.canonicalBytes || !row.canonicalSha256) return null;
    const refs = await this.db
      .select({ id: sourceQueryRevisions.id })
      .from(promptRevisionSourceQueries)
      .innerJoin(
        sourceQueryRevisions,
        eq(sourceQueryRevisions.id, promptRevisionSourceQueries.sourceQueryRevisionId),
      )
      .where(eq(promptRevisionSourceQueries.promptRevisionId, row.id))
      .orderBy(asc(promptRevisionSourceQueries.position));
    return {
      id: row.id,
      projectId: row.projectId,
      revision: row.revision,
      status: row.status,
      canonicalBytes: bytes(row.canonicalBytes),
      canonicalSha256: row.canonicalSha256,
      requiredEvidence: stringArray(row.requiredEvidence) as V2ConfigRevision["requiredEvidence"],
      sourceQueryIds: refs.map((ref) => ref.id),
    };
  }

  async getSourceQueryRevision(
    userId: number,
    projectId: string,
    queryId: string,
  ): Promise<V2SourceQueryRevision | null> {
    const rows = await this.db
      .select({
        id: sourceQueryRevisions.id,
        projectId: sourceQueryRevisions.projectId,
        adapter: sourceQueryRevisions.adapter,
        revision: sourceQueryRevisions.revision,
        status: sourceQueryRevisions.status,
        canonicalBytes: sourceQueryRevisions.canonicalBytes,
        canonicalSha256: sourceQueryRevisions.canonicalSha256,
        acquisitionBasisHash: sourceQueryRevisions.acquisitionBasisHash,
      })
      .from(sourceQueryRevisions)
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.projectId, sourceQueryRevisions.projectId),
          eq(projectMemberships.userId, userId),
        ),
      )
      .where(
        and(eq(sourceQueryRevisions.id, queryId), eq(sourceQueryRevisions.projectId, projectId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      adapter: row.adapter,
      revision: row.revision,
      status: row.status,
      canonicalBytes: bytes(row.canonicalBytes),
      canonicalSha256: row.canonicalSha256,
      acquisitionBasisHash: row.acquisitionBasisHash,
    };
  }

  async createConfigRevision(input: CreateConfigInput): Promise<V2ConfigRevision> {
    return this.db.transaction(async (transaction) => {
      const projectRows = await transaction
        .select()
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.status, "active")))
        .limit(1)
        .for("update");
      const project = projectRows[0];
      if (!project) notFound();
      const [membership] = await transaction
        .select({ projectId: projectMemberships.projectId })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.projectId, input.projectId),
            eq(projectMemberships.userId, input.userId),
          ),
        )
        .limit(1);
      if (!membership) notFound();
      if (input.expectedRevision !== null && input.expectedRevision !== project.promptRevision) {
        conflict("The project configuration changed; refresh before editing.", {
          expected_revision: input.expectedRevision,
          actual_revision: project.promptRevision,
        });
      }
      const queryIds = new Set<string>();
      const queryRefs: Array<{ id: string; revision: number; sha256: string; position: number }> =
        [];
      for (const [position, query] of input.sourceQueries.entries()) {
        const key = `${query.adapter}:${query.queryIdentity}`;
        if (queryIds.has(key)) conflict("A source query may appear only once in a configuration.");
        queryIds.add(key);
        ensureHash(query.queryIdentity);
        ensureHash(query.acquisitionBasisHash);
        ensureHash(query.canonicalSha256);
        const existingRows = await transaction
          .select()
          .from(sourceQueryRevisions)
          .where(
            and(
              eq(sourceQueryRevisions.projectId, input.projectId),
              eq(sourceQueryRevisions.adapter, query.adapter),
              eq(sourceQueryRevisions.queryIdentity, query.queryIdentity),
            ),
          )
          .limit(1)
          .for("update");
        let existing = existingRows[0];
        if (existing && !queryInputEqual(existing as Row, query)) {
          conflict("The source query identity already has different canonical bytes.");
        }
        if (!existing) {
          const [latest] = await transaction
            .select({ revision: sql<number>`coalesce(max(${sourceQueryRevisions.revision}), 0)` })
            .from(sourceQueryRevisions)
            .where(
              and(
                eq(sourceQueryRevisions.projectId, input.projectId),
                eq(sourceQueryRevisions.adapter, query.adapter),
              ),
            );
          const [created] = await transaction
            .insert(sourceQueryRevisions)
            .values({
              projectId: input.projectId,
              adapter: query.adapter,
              revision: Number(latest?.revision ?? 0) + 1,
              normalizedQuery: query.normalizedQuery,
              queryIdentity: query.queryIdentity,
              acquisitionBasisHash: query.acquisitionBasisHash,
              canonicalBytes: query.canonicalBytes,
              canonicalSha256: query.canonicalSha256,
              status: "ready",
            })
            .returning();
          if (!created) throw new Error("source query insert returned no row");
          existing = created;
        } else if (existing.status === "needs_review") {
          const [ready] = await transaction
            .update(sourceQueryRevisions)
            .set({ status: "ready" })
            .where(eq(sourceQueryRevisions.id, existing.id))
            .returning();
          existing = ready ?? existing;
        }
        queryRefs.push({
          id: existing.id,
          revision: existing.revision,
          sha256: existing.canonicalSha256,
          position,
        });
      }
      const revision = project.promptRevision + 1;
      const payload = {
        version: 1,
        prompt: input.prompt,
        criteria: input.criteria,
        required_evidence: input.requiredEvidence,
        acquisition_basis: input.acquisitionBasis,
        source_queries: queryRefs,
      };
      const canonical = canonicalJsonBytes(payload);
      const canonicalSha256 = canonicalJsonSha256(payload);
      const [created] = await transaction
        .insert(promptRevisions)
        .values({
          projectId: input.projectId,
          revision,
          prompt: input.prompt,
          criteria: input.criteria,
          configStatus: "complete",
          requiredEvidence: input.requiredEvidence,
          acquisitionBasis: input.acquisitionBasis,
          canonicalBytes: canonical,
          canonicalSha256,
          editorId: input.userId,
        })
        .returning();
      if (!created) throw new Error("configuration revision insert returned no row");
      await transaction.insert(promptRevisionSourceQueries).values(
        queryRefs.map((query) => ({
          promptRevisionId: created.id,
          sourceQueryRevisionId: query.id,
          position: query.position,
        })),
      );
      await transaction
        .update(projects)
        .set({
          currentPrompt: input.prompt,
          criteria: input.criteria,
          promptRevision: revision,
          currentConfigRevisionId: created.id,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, input.projectId));
      const [sequence] = await transaction
        .update(projects)
        .set({ latestChangeSequence: sql`${projects.latestChangeSequence} + 1` })
        .where(eq(projects.id, input.projectId))
        .returning({ sequence: projects.latestChangeSequence });
      if (!sequence) throw new Error("configuration project disappeared");
      await transaction.insert(projectChanges).values({
        projectId: input.projectId,
        sequence: sequence.sequence,
        eventType: "config_revision.created",
        objectType: "prompt_revision",
        objectId: String(created.id),
        payload: { revision, config_status: "complete" },
        actorId: input.userId,
        actorKind: "user",
      });
      await transaction.insert(auditEvents).values({
        projectId: input.projectId,
        action: "config_revision.created",
        objectType: "prompt_revision",
        objectId: String(created.id),
        actorKind: "user",
        actorId: input.userId,
        summary: { revision, source_query_count: queryRefs.length },
      });
      return {
        id: created.id,
        projectId: created.projectId,
        revision: created.revision,
        status: created.configStatus,
        canonicalBytes: canonical,
        canonicalSha256,
        requiredEvidence: input.requiredEvidence,
        sourceQueryIds: queryRefs.map((query) => query.id),
      };
    });
  }

  async createRun(input: CreateRunInput): Promise<{ run: V2RunRecord; replayed: boolean }> {
    return this.db.transaction(async (transaction) => {
      const existingRows = await transaction
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.invocationId, input.invocationId))
        .limit(1)
        .for("update");
      if (existingRows[0]) {
        const existing = existingRows[0];
        if (existing.userId !== input.userId || existing.tokenId !== input.tokenId) notFound();
        if (existing.agentLabel !== input.agentLabel) {
          conflict("The invocation ID was already used with a different request.");
        }
        return {
          run: await mapRun(transaction as unknown as Database, existing as Row),
          replayed: true,
        };
      }
      if (input.projects.length === 0) conflict("A run must snapshot at least one project.");
      const [created] = await transaction
        .insert(agentRuns)
        .values({
          invocationId: input.invocationId,
          userId: input.userId,
          tokenId: input.tokenId,
          agentLabel: input.agentLabel,
        })
        .returning();
      if (!created) throw new Error("agent run insert returned no row");
      for (const project of input.projects) {
        await assertMembership(transaction as unknown as Database, input.userId, project.projectId);
        const [config] = await transaction
          .select({
            projectId: promptRevisions.projectId,
            revision: promptRevisions.revision,
            sha256: promptRevisions.canonicalSha256,
            status: promptRevisions.configStatus,
          })
          .from(promptRevisions)
          .where(
            and(
              eq(promptRevisions.id, project.promptRevisionId),
              eq(promptRevisions.projectId, project.projectId),
            ),
          )
          .limit(1);
        if (
          config?.status !== "complete" ||
          config.revision !== project.promptRevision ||
          config.sha256 !== project.canonicalSha256
        ) {
          conflict("The run snapshot does not match an immutable configuration revision.");
        }
        await transaction.insert(agentRunProjects).values({
          runId: created.id,
          projectId: project.projectId,
          promptRevisionId: project.promptRevisionId,
          promptRevision: project.promptRevision,
          canonicalSha256: project.canonicalSha256,
        });
        for (const query of project.queries) {
          ensureHash(query.canonicalSha256);
          const [source] = await transaction
            .select({
              revision: sourceQueryRevisions.revision,
              sha256: sourceQueryRevisions.canonicalSha256,
            })
            .from(sourceQueryRevisions)
            .where(
              and(
                eq(sourceQueryRevisions.id, query.sourceQueryRevisionId),
                eq(sourceQueryRevisions.projectId, project.projectId),
              ),
            )
            .limit(1);
          if (
            !source ||
            source.revision !== query.sourceQueryRevision ||
            source.sha256 !== query.canonicalSha256
          ) {
            conflict("The run snapshot does not match an immutable source-query revision.");
          }
          await transaction.insert(agentRunQueries).values({
            runId: created.id,
            projectId: project.projectId,
            sourceQueryRevisionId: query.sourceQueryRevisionId,
            sourceQueryRevision: query.sourceQueryRevision,
            canonicalSha256: query.canonicalSha256,
          });
        }
      }
      return {
        run: await mapRun(transaction as unknown as Database, created as Row),
        replayed: false,
      };
    });
  }

  async finalizeRun(
    userId: number,
    tokenId: string,
    runId: string,
    report: AgentRunReport,
  ): Promise<{ run: V2RunRecord; replayed: boolean }> {
    return this.db.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.userId, userId),
            eq(agentRuns.tokenId, tokenId),
          ),
        )
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row) notFound();
      const current = await mapRun(transaction as unknown as Database, row as Row);
      if (current.status !== "started") {
        if (JSON.stringify(current.report) !== JSON.stringify(report)) {
          conflict("The run already has a different terminal report.");
        }
        return { run: current, replayed: true };
      }
      const snapshotQueries = await transaction
        .select()
        .from(agentRunQueries)
        .where(eq(agentRunQueries.runId, runId));
      const snapshotIds = new Set(snapshotQueries.map((query) => query.sourceQueryRevisionId));
      if (
        report.queries.length !== snapshotQueries.length ||
        report.queries.some((query) => !snapshotIds.has(query.source_query_revision_id))
      ) {
        conflict("The run report must include exactly its snapshotted source queries.");
      }
      for (const query of report.queries) {
        await transaction
          .update(agentRunQueries)
          .set({ status: query.status, errorClass: query.error_class ?? null })
          .where(
            and(
              eq(agentRunQueries.runId, runId),
              eq(agentRunQueries.sourceQueryRevisionId, query.source_query_revision_id),
            ),
          );
      }
      await transaction
        .update(agentRuns)
        .set({
          status: report.status,
          phase: report.phase,
          sourceQueriesAttempted: report.counts.source_queries_attempted,
          sourceQueriesCompleted: report.counts.source_queries_completed,
          candidatesObserved: report.counts.candidates_observed,
          candidatesEvaluated: report.counts.candidates_evaluated,
          candidatesKept: report.counts.candidates_kept,
          candidatesInsufficient: report.counts.candidates_insufficient,
          deliveriesAcknowledged: report.counts.deliveries_acknowledged,
          deliveriesPending: report.counts.deliveries_pending,
          failurePhase: report.failure?.phase ?? null,
          failureCode: report.failure?.code ?? null,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));
      const [updated] = await transaction
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (!updated) throw new Error("agent run disappeared during finalization");
      return {
        run: await mapRun(transaction as unknown as Database, updated as Row),
        replayed: false,
      };
    });
  }

  async deliver(input: DeliverInput): Promise<DeliverResult> {
    return this.db.transaction(async (transaction) => {
      await assertMembership(
        transaction as unknown as Database,
        input.userId,
        input.projectId,
        true,
      );
      const [promptRevision] = await transaction
        .select({ projectId: promptRevisions.projectId, status: promptRevisions.configStatus })
        .from(promptRevisions)
        .where(eq(promptRevisions.id, input.promptRevisionId))
        .limit(1);
      if (
        !promptRevision ||
        promptRevision.projectId !== input.projectId ||
        promptRevision.status !== "complete"
      ) {
        notFound();
      }
      ensureHash(input.factsHash);
      const existingLeadRows = await transaction
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            eq(leads.projectId, input.projectId),
            eq(leads.source, input.lead.source),
            eq(leads.sourceListingId, input.lead.sourceListingId),
          ),
        )
        .limit(1)
        .for("update");
      let leadId = existingLeadRows[0]?.id;
      const status: DeliverResult["status"] = leadId ? "existing" : "created";
      if (!leadId) {
        const [created] = await transaction
          .insert(leads)
          .values({
            projectId: input.projectId,
            source: input.lead.source,
            sourceListingId: input.lead.sourceListingId,
            canonicalUrl: input.lead.canonicalUrl,
            identityHash: canonicalJsonSha256({
              source: input.lead.source,
              source_listing_id: input.lead.sourceListingId,
            }),
            sourceUrl: input.lead.canonicalUrl,
            title: input.lead.title,
            summary: input.lead.summary,
            location: input.lead.location,
            priceDisplay: input.lead.priceDisplay,
            priceAmount: input.lead.priceAmount,
            priceCurrency: input.lead.priceCurrency,
            availability: input.lead.availability,
            housingType: input.lead.housingType,
            listedAt: input.lead.listedAt,
            attributes: input.lead.attributes,
            verificationNotes: input.lead.verificationNotes,
            creatorId: input.userId,
          })
          .returning({ id: leads.id });
        if (!created) throw new Error("lead insert returned no row");
        leadId = created.id;
      }
      const observations = await transaction
        .insert(matchObservations)
        .values({
          projectId: input.projectId,
          leadId,
          promptRevisionId: input.promptRevisionId,
          factsHash: input.factsHash,
          disposition: input.disposition,
          reason: input.reason,
          unknowns: input.unknowns,
        })
        .onConflictDoNothing({
          target: [
            matchObservations.projectId,
            matchObservations.leadId,
            matchObservations.promptRevisionId,
            matchObservations.factsHash,
          ],
        })
        .returning({ id: matchObservations.id });
      const observationId = observations[0]?.id;
      if (observationId) return { status, leadId, observationId };
      const [existing] = await transaction
        .select({ id: matchObservations.id })
        .from(matchObservations)
        .where(
          and(
            eq(matchObservations.projectId, input.projectId),
            eq(matchObservations.leadId, leadId),
            eq(matchObservations.promptRevisionId, input.promptRevisionId),
            eq(matchObservations.factsHash, input.factsHash),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("match observation disappeared during delivery");
      return { status: "existing", leadId, observationId: existing.id };
    });
  }

  async finalizeSourceWrite(tokenId: string, now: Date): Promise<AgentTokenRecord | null> {
    return this.db.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(agentTokens)
        .where(eq(agentTokens.id, tokenId))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row || row.revokedAt || row.expiresAt <= now) return null;
      const scopes = stringArray(row.scopes).filter((scope) => scope !== "source-config:write");
      const [updated] = await transaction
        .update(agentTokens)
        .set({ scopes, sourceWriteExpiresAt: null })
        .where(eq(agentTokens.id, tokenId))
        .returning();
      return updated ? tokenRecord(updated as Row) : null;
    });
  }

  async grantSourceWrite(
    userId: number,
    tokenId: string,
    now: Date,
  ): Promise<AgentTokenRecord | null> {
    return this.db.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(agentTokens)
        .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.userId, userId)))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row || row.revokedAt || row.expiresAt <= now) return null;
      const existingScopes = stringArray(row.scopes);
      if (!existingScopes.some((scope) => V2_AGENT_SCOPE_SET.has(scope))) return null;
      const scopes = [...new Set([...existingScopes, "source-config:write"])];
      const [updated] = await transaction
        .update(agentTokens)
        .set({ scopes, sourceWriteExpiresAt: new Date(now.getTime() + 15 * 60_000) })
        .where(eq(agentTokens.id, tokenId))
        .returning();
      return updated ? tokenRecord(updated as Row) : null;
    });
  }
}

export function createPostgresV2Repository(): PostgresV2Repository {
  return new PostgresV2Repository();
}
