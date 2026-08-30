import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  decimal,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const projectStatus = pgEnum("project_status", ["active", "trashed"]);
export const membershipRole = pgEnum("membership_role", ["owner", "editor", "viewer"]);
export const linkStatus = pgEnum("agent_link_status", [
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
]);
export const runStatus = pgEnum("search_run_status", [
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const leadStatus = pgEnum("lead_status", ["active", "trashed"]);
export const housingType = pgEnum("housing_type", ["entire", "shared", "unknown"]);
export const dateConfidence = pgEnum("date_confidence", ["strong", "verify", "unknown"]);
export const sourceReviewStatus = pgEnum("source_review_status", ["open", "resolved"]);
export const agentProtocolVersion = pgEnum("agent_protocol_version", ["v1", "v2"]);
export const agentConfigStatus = pgEnum("agent_config_status", [
  "legacy",
  "needs_review",
  "complete",
]);
export const sourceAdapter = pgEnum("source_adapter", ["zumper-com", "streeteasy-com"]);
export const sourceQueryStatus = pgEnum("source_query_status", ["needs_review", "ready"]);
export const agentRunStatus = pgEnum("agent_run_status", [
  "started",
  "completed",
  "incomplete",
  "failed",
]);
export const agentRunPhase = pgEnum("agent_run_phase", [
  "snapshot",
  "acquire",
  "match",
  "deliver",
  "finish",
]);
export const agentRunQueryStatus = pgEnum("agent_run_query_status", [
  "pending",
  "completed",
  "blocked",
  "unavailable",
  "malformed",
  "partial",
]);
export const matchDisposition = pgEnum("match_disposition", [
  "pending",
  "rejected",
  "insufficient",
  "kept",
]);

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

export const users = pgTable(
  "users",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    email: varchar("email", { length: 254 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordResetRequired: boolean("password_reset_required").notNull().default(false),
    lastLogin: timestamp("last_login", { withTimezone: true }),
    legacyIsStaff: boolean("legacy_is_staff").notNull().default(false),
    legacyIsSuperuser: boolean("legacy_is_superuser").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_ci_uniq").on(sql`lower(${table.email})`)],
);

export const profiles = pgTable("profiles", {
  userId: bigint("user_id", { mode: "number" })
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  bio: text("bio").notNull().default(""),
  personalDetails: jsonb("personal_details").$type<Record<string, unknown>>().notNull().default({}),
  agentPausedUntil: timestamp("agent_paused_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const savedPrompts = pgTable(
  "saved_prompts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }).notNull(),
    prompt: text("prompt").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("saved_prompts_user_title_uniq").on(table.userId, table.title)],
);

export const sessions = pgTable(
  "sessions",
  {
    digest: varchar("digest", { length: 64 }).primaryKey(),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "cascade",
    }),
    csrfDigest: varchar("csrf_digest", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_expiry_idx").on(table.expiresAt)],
);

export const authThrottles = pgTable("auth_throttles", {
  keyDigest: varchar("key_digest", { length: 64 }).primaryKey(),
  failureCount: integer("failure_count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    tokenPrefix: varchar("token_prefix", { length: 16 }).notNull(),
    digest: varchar("digest", { length: 64 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    projectIds: jsonb("project_ids").$type<string[]>().notNull().default([]),
    expectedCadenceMinutes: integer("expected_cadence_minutes"),
    environmentNote: varchar("environment_note", { length: 200 }).notNull().default(""),
    exposedToChat: boolean("exposed_to_chat").notNull().default(false),
    sourceWriteExpiresAt: timestamp("source_write_expires_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("agent_tokens_digest_uniq").on(table.digest)],
);

export const agentLinks = pgTable(
  "agent_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceCodeDigest: varchar("device_code_digest", { length: 64 }).notNull(),
    userCode: varchar("user_code", { length: 8 }).notNull(),
    agentLabel: varchar("agent_label", { length: 120 }).notNull(),
    environmentNote: varchar("environment_note", { length: 200 }).notNull().default(""),
    requestedCadenceMinutes: integer("requested_cadence_minutes"),
    protocolVersion: agentProtocolVersion("protocol_version").notNull().default("v1"),
    status: linkStatus("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    pollCount: integer("poll_count").notNull().default(0),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    approvedById: bigint("approved_by_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    issuedTokenId: uuid("issued_token_id").references(() => agentTokens.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_links_device_digest_uniq").on(table.deviceCodeDigest),
    index("agent_links_code_status_idx").on(table.userCode, table.status, table.expiresAt),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 220 }).notNull(),
    description: text("description").notNull().default(""),
    currentPrompt: text("current_prompt").notNull().default(""),
    criteria: jsonb("criteria").$type<Record<string, unknown>>().notNull().default({}),
    status: projectStatus("status").notNull().default("active"),
    creatorId: bigint("creator_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    promptRevision: integer("prompt_revision").notNull().default(0),
    currentConfigRevisionId: bigint("current_config_revision_id", { mode: "number" }).references(
      (): AnyPgColumn => promptRevisions.id,
      { onDelete: "set null" },
    ),
    latestChangeSequence: bigint("latest_change_sequence", { mode: "number" }).notNull().default(0),
    feedEpoch: varchar("feed_epoch", { length: 64 }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("projects_slug_uniq").on(table.slug)],
);

export const projectMemberships = pgTable(
  "project_memberships",
  {
    projectId: uuid("project_id")
      .notNull()
      .references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);

export const projectInvitations = pgTable(
  "project_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 254 }).notNull(),
    role: membershipRole("role").notNull().default("viewer"),
    inviterId: bigint("inviter_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenDigest: varchar("token_digest", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("project_invitations_token_uniq").on(table.tokenDigest)],
);

export const promptRevisions = pgTable(
  "prompt_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    prompt: text("prompt").notNull(),
    criteria: jsonb("criteria").$type<Record<string, unknown>>().notNull().default({}),
    configStatus: agentConfigStatus("config_status").notNull().default("legacy"),
    requiredEvidence: jsonb("required_evidence").$type<string[]>().notNull().default([]),
    acquisitionBasis: jsonb("acquisition_basis").$type<Record<string, unknown>>(),
    canonicalBytes: bytea("canonical_bytes"),
    canonicalSha256: varchar("canonical_sha256", { length: 64 }),
    editorId: bigint("editor_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("prompt_revisions_project_revision_uniq").on(table.projectId, table.revision),
    uniqueIndex("prompt_revisions_id_project_uniq").on(table.id, table.projectId),
    check(
      "prompt_revisions_v2_payload_complete",
      sql`(${table.configStatus} = 'legacy') or
          (${table.acquisitionBasis} is not null and ${table.canonicalBytes} is not null and
           ${table.canonicalSha256} is not null and ${table.canonicalSha256} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

export const sourceQueryRevisions = pgTable(
  "source_query_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    adapter: sourceAdapter("adapter").notNull(),
    revision: integer("revision").notNull(),
    normalizedQuery: jsonb("normalized_query").$type<Record<string, unknown>>().notNull(),
    queryIdentity: varchar("query_identity", { length: 64 }).notNull(),
    acquisitionBasisHash: varchar("acquisition_basis_hash", { length: 64 }).notNull(),
    canonicalBytes: bytea("canonical_bytes").notNull(),
    canonicalSha256: varchar("canonical_sha256", { length: 64 }).notNull(),
    status: sourceQueryStatus("status").notNull().default("needs_review"),
    creationPromptRevisionId: bigint("creation_prompt_revision_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_query_revisions_id_project_uniq").on(table.id, table.projectId),
    foreignKey({
      columns: [table.creationPromptRevisionId, table.projectId],
      foreignColumns: [promptRevisions.id, promptRevisions.projectId],
      name: "source_query_revisions_creation_prompt_revision_project_fk",
    }).onDelete("set null"),
    index("source_query_revisions_project_adapter_identity_idx").on(
      table.projectId,
      table.adapter,
      table.queryIdentity,
    ),
    uniqueIndex("source_query_revisions_project_adapter_revision_uniq").on(
      table.projectId,
      table.adapter,
      table.revision,
    ),
    check(
      "source_query_revisions_query_identity_hex",
      sql`${table.queryIdentity} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "source_query_revisions_basis_hash_hex",
      sql`${table.acquisitionBasisHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "source_query_revisions_canonical_hash_hex",
      sql`${table.canonicalSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const promptRevisionSourceQueries = pgTable(
  "prompt_revision_source_queries",
  {
    promptRevisionId: bigint("prompt_revision_id", { mode: "number" })
      .notNull()
      .references(() => promptRevisions.id, { onDelete: "cascade" }),
    sourceQueryRevisionId: uuid("source_query_revision_id")
      .notNull()
      .references(() => sourceQueryRevisions.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.promptRevisionId, table.sourceQueryRevisionId] }),
    uniqueIndex("prompt_revision_source_queries_position_uniq").on(
      table.promptRevisionId,
      table.position,
    ),
    check(
      "prompt_revision_source_queries_position_bounds",
      sql`${table.position} >= 0 and ${table.position} < 8`,
    ),
  ],
);

export const searchRuns = pgTable(
  "search_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenId: uuid("token_id").references(() => agentTokens.id, { onDelete: "set null" }),
    agentLabel: varchar("agent_label", { length: 160 }).notNull(),
    promptRevision: integer("prompt_revision").notNull(),
    promptSnapshot: text("prompt_snapshot").notNull(),
    criteriaSnapshot: jsonb("criteria_snapshot").$type<Record<string, unknown>>().notNull(),
    status: runStatus("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    leaseOwner: varchar("lease_owner", { length: 120 }).notNull().default(""),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    claimTokenDigest: varchar("claim_token_digest", { length: 64 }).notNull().default(""),
    attemptCount: integer("attempt_count").notNull().default(0),
    inputCursor: varchar("input_cursor", { length: 2000 }).notNull().default(""),
    outputCursor: varchar("output_cursor", { length: 2000 }).notNull().default(""),
    continuation: jsonb("continuation").$type<Record<string, unknown>>().notNull().default({}),
    resultCounts: jsonb("result_counts").$type<Record<string, number>>().notNull().default({}),
    summary: text("summary").notNull().default(""),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull().default(""),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("search_runs_agent_idempotency_uniq")
      .on(table.projectId, table.userId, table.tokenId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} <> '' and ${table.tokenId} is not null`),
    uniqueIndex("search_runs_session_idempotency_uniq")
      .on(table.projectId, table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} <> '' and ${table.tokenId} is null`),
    index("search_runs_active_idx").on(table.projectId, table.status, table.leaseExpiresAt),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invocationId: uuid("invocation_id").notNull(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenId: uuid("token_id").references(() => agentTokens.id, { onDelete: "set null" }),
    agentLabel: varchar("agent_label", { length: 160 }).notNull(),
    status: agentRunStatus("status").notNull().default("started"),
    phase: agentRunPhase("phase").notNull().default("snapshot"),
    sourceQueriesAttempted: integer("source_queries_attempted").notNull().default(0),
    sourceQueriesCompleted: integer("source_queries_completed").notNull().default(0),
    candidatesObserved: integer("candidates_observed").notNull().default(0),
    candidatesEvaluated: integer("candidates_evaluated").notNull().default(0),
    candidatesKept: integer("candidates_kept").notNull().default(0),
    candidatesInsufficient: integer("candidates_insufficient").notNull().default(0),
    deliveriesAcknowledged: integer("deliveries_acknowledged").notNull().default(0),
    deliveriesPending: integer("deliveries_pending").notNull().default(0),
    failurePhase: varchar("failure_phase", { length: 24 }),
    failureCode: varchar("failure_code", { length: 64 }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agent_runs_invocation_uniq").on(table.invocationId),
    check(
      "agent_runs_counts_nonnegative",
      sql`
        ${table.sourceQueriesAttempted} >= 0 and
        ${table.sourceQueriesCompleted} >= 0 and
        ${table.candidatesObserved} >= 0 and
        ${table.candidatesEvaluated} >= 0 and
        ${table.candidatesKept} >= 0 and
        ${table.candidatesInsufficient} >= 0 and
        ${table.deliveriesAcknowledged} >= 0 and
        ${table.deliveriesPending} >= 0
      `,
    ),
    check(
      "agent_runs_evaluated_lte_observed",
      sql`${table.candidatesEvaluated} <= ${table.candidatesObserved}`,
    ),
    check(
      "agent_runs_dispositions_lte_evaluated",
      sql`${table.candidatesKept} + ${table.candidatesInsufficient} <= ${table.candidatesEvaluated}`,
    ),
  ],
);

export const agentRunProjects = pgTable(
  "agent_run_projects",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    promptRevisionId: bigint("prompt_revision_id", { mode: "number" }).notNull(),
    promptRevision: integer("prompt_revision").notNull(),
    canonicalSha256: varchar("canonical_sha256", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.projectId] }),
    foreignKey({
      columns: [table.promptRevisionId, table.projectId],
      foreignColumns: [promptRevisions.id, promptRevisions.projectId],
      name: "agent_run_projects_prompt_revision_project_fk",
    }).onDelete("restrict"),
    check(
      "agent_run_projects_canonical_hash_hex",
      sql`${table.canonicalSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const agentRunQueries = pgTable(
  "agent_run_queries",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceQueryRevisionId: uuid("source_query_revision_id").notNull(),
    sourceQueryRevision: integer("source_query_revision").notNull(),
    canonicalSha256: varchar("canonical_sha256", { length: 64 }).notNull(),
    status: agentRunQueryStatus("status").notNull().default("pending"),
    errorClass: varchar("error_class", { length: 64 }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sourceQueryRevisionId] }),
    foreignKey({
      columns: [table.runId, table.projectId],
      foreignColumns: [agentRunProjects.runId, agentRunProjects.projectId],
      name: "agent_run_queries_run_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sourceQueryRevisionId, table.projectId],
      foreignColumns: [sourceQueryRevisions.id, sourceQueryRevisions.projectId],
      name: "agent_run_queries_source_query_revision_project_fk",
    }).onDelete("restrict"),
    check("agent_run_queries_canonical_hash_hex", sql`${table.canonicalSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 160 }).notNull(),
    sourceListingId: varchar("source_listing_id", { length: 300 }).notNull().default(""),
    canonicalUrl: varchar("canonical_url", { length: 2000 }).notNull(),
    identityHash: varchar("identity_hash", { length: 64 }).notNull().default(""),
    sourceUrl: varchar("source_url", { length: 2000 }).notNull().default(""),
    title: varchar("title", { length: 500 }).notNull(),
    summary: text("summary").notNull().default(""),
    location: varchar("location", { length: 500 }).notNull().default(""),
    priceDisplay: varchar("price_display", { length: 200 }).notNull().default(""),
    priceAmount: decimal("price_amount", { precision: 10, scale: 2 }),
    priceCurrency: varchar("price_currency", { length: 3 }).notNull().default("USD"),
    availability: varchar("availability", { length: 500 }).notNull().default(""),
    housingType: housingType("housing_type").notNull().default("unknown"),
    dateConfidence: dateConfidence("date_confidence").notNull().default("unknown"),
    listedAt: date("listed_at"),
    parkNotes: varchar("park_notes", { length: 1000 }).notNull().default(""),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    verificationNotes: text("verification_notes").notNull().default(""),
    status: leadStatus("status").notNull().default("active"),
    trashedById: bigint("trashed_by_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    creatorId: bigint("creator_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("leads_id_project_uniq").on(table.id, table.projectId),
    uniqueIndex("leads_source_identity_uniq")
      .on(table.projectId, table.source, table.sourceListingId)
      .where(sql`${table.sourceListingId} <> ''`),
    uniqueIndex("leads_url_identity_uniq")
      .on(table.projectId, table.identityHash)
      .where(sql`${table.identityHash} <> ''`),
    index("leads_project_status_updated_idx").on(table.projectId, table.status, table.updatedAt),
    check("leads_revision_positive", sql`${table.revision} >= 1`),
  ],
);

export const matchObservations = pgTable(
  "match_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    promptRevisionId: bigint("prompt_revision_id", { mode: "number" })
      .notNull()
      .references(() => promptRevisions.id, { onDelete: "restrict" }),
    factsHash: varchar("facts_hash", { length: 64 }).notNull(),
    disposition: matchDisposition("disposition").notNull().default("pending"),
    reason: varchar("reason", { length: 500 }).notNull().default(""),
    unknowns: jsonb("unknowns").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.leadId, table.projectId],
      foreignColumns: [leads.id, leads.projectId],
      name: "match_observations_lead_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.promptRevisionId, table.projectId],
      foreignColumns: [promptRevisions.id, promptRevisions.projectId],
      name: "match_observations_prompt_revision_project_fk",
    }).onDelete("restrict"),
    uniqueIndex("match_observations_identity_uniq").on(
      table.projectId,
      table.leadId,
      table.promptRevisionId,
      table.factsHash,
    ),
    check("match_observations_facts_hash_hex", sql`${table.factsHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const leadInterests = pgTable(
  "lead_interests",
  {
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.leadId, table.userId] })],
);

export const leadComments = pgTable("lead_comments", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id, { onDelete: "cascade" }),
  authorId: bigint("author_id", { mode: "number" })
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  parentId: bigint("parent_id", { mode: "number" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const projectChanges = pgTable(
  "project_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    objectType: varchar("object_type", { length: 80 }).notNull(),
    objectId: varchar("object_id", { length: 100 }).notNull().default(""),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    tombstone: boolean("tombstone").notNull().default(false),
    actorId: bigint("actor_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    actorKind: varchar("actor_kind", { length: 24 }).notNull().default("user"),
    tokenId: uuid("token_id").references(() => agentTokens.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("project_changes_sequence_uniq").on(table.projectId, table.sequence)],
);

export const sourcePlanReviews = pgTable(
  "source_plan_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reportedByTokenId: uuid("reported_by_token_id").references(() => agentTokens.id, {
      onDelete: "set null",
    }),
    resolvedByTokenId: uuid("resolved_by_token_id").references(() => agentTokens.id, {
      onDelete: "set null",
    }),
    status: sourceReviewStatus("status").notNull().default("open"),
    observedPromptRevision: integer("observed_prompt_revision").notNull(),
    resolvedPromptRevision: integer("resolved_prompt_revision"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("source_plan_reviews_open_uniq")
      .on(table.projectId, table.userId)
      .where(sql`${table.status} = 'open'`),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").references(() => agentTokens.id, { onDelete: "cascade" }),
    endpoint: varchar("endpoint", { length: 220 }).notNull(),
    key: varchar("key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_agent_principal_endpoint_key_uniq")
      .on(table.userId, table.tokenId, table.endpoint, table.key)
      .where(sql`${table.tokenId} is not null`),
    uniqueIndex("idempotency_session_principal_endpoint_key_uniq")
      .on(table.userId, table.endpoint, table.key)
      .where(sql`${table.tokenId} is null`),
    index("idempotency_expiry_idx").on(table.expiresAt),
  ],
);

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  action: varchar("action", { length: 120 }).notNull(),
  objectType: varchar("object_type", { length: 80 }).notNull(),
  objectId: varchar("object_id", { length: 100 }).notNull().default(""),
  actorKind: varchar("actor_kind", { length: 24 }).notNull(),
  actorId: bigint("actor_id", { mode: "number" }).references(() => users.id, {
    onDelete: "set null",
  }),
  tokenId: uuid("token_id").references(() => agentTokens.id, { onDelete: "set null" }),
  requestId: varchar("request_id", { length: 100 }).notNull().default(""),
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const migrationRecords = pgTable("migration_records", {
  sourceProjectId: uuid("source_project_id").primaryKey(),
  sourceChecksum: varchar("source_checksum", { length: 64 }).notNull(),
  targetChecksum: varchar("target_checksum", { length: 64 }).notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Lead = typeof leads.$inferSelect;
