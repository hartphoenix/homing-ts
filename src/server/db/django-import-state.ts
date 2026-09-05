import { createHash } from "node:crypto";
import postgres from "postgres";

import { isSupportedImportedHash } from "../auth/password";

type DatabaseTimestamp = string;
type JsonText = string;

const losslessMigrationTypes = {
  exactJson: {
    to: 3802,
    from: [114, 3802],
    serialize: (value: string) => value,
    parse: (value: string) => value,
  },
  exactTimestamp: {
    to: 1184,
    from: [1082, 1114, 1184],
    serialize: (value: string) => value,
    parse: (value: string) => value,
  },
};

type LosslessMigrationValues = {
  exactJson: string;
  exactTimestamp: string;
};

export function createMigrationClient(url: string) {
  return postgres(url, {
    max: 1,
    prepare: false,
    types: losslessMigrationTypes,
  });
}

export type ImportUser = {
  id: number;
  email: string;
  password_hash: string;
  password_reset_required: boolean;
  last_login: DatabaseTimestamp | null;
  is_staff: boolean;
  is_superuser: boolean;
  is_active: boolean;
  date_joined: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  display_name: string;
  timezone: string;
  bio: string;
  personal_details: JsonText;
  profile_updated_at: DatabaseTimestamp;
};

export type ImportProject = {
  id: string;
  name: string;
  slug: string;
  description: string;
  prompt: string;
  criteria: JsonText;
  status: "active" | "trashed";
  prompt_revision: number;
  latest_change_sequence: number;
  creator_id: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

type ImportMembership = {
  project_id: string;
  user_id: number;
  role: "owner" | "editor" | "viewer";
  joined_at: DatabaseTimestamp;
};

type ImportInvitation = {
  id: string;
  project_id: string;
  email: string;
  role: "editor" | "viewer";
  inviter_id: number;
  token_digest: string;
  expires_at: DatabaseTimestamp;
  accepted_at: DatabaseTimestamp | null;
  revoked_at: DatabaseTimestamp | null;
  created_at: DatabaseTimestamp;
};

type ImportPromptRevision = {
  id: number;
  project_id: string;
  revision: number;
  prompt: string;
  criteria: JsonText;
  editor_id: number;
  created_at: DatabaseTimestamp;
};

type ImportSavedPrompt = {
  id: number;
  user_id: number;
  title: string;
  prompt: string;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

type ImportThrottle = {
  key_digest: string;
  failure_count: number;
  window_started_at: DatabaseTimestamp;
  blocked_until: DatabaseTimestamp | null;
  updated_at: DatabaseTimestamp;
};

type ImportToken = {
  id: string;
  user_id: number;
  name: string;
  token_prefix: string;
  digest: string;
  scopes: JsonText;
  project_ids: JsonText;
  expected_cadence_minutes: number | null;
  environment_note: string;
  exposed_to_chat: boolean;
  expires_at: DatabaseTimestamp;
  revoked_at: DatabaseTimestamp | null;
  last_used_at: DatabaseTimestamp | null;
  created_at: DatabaseTimestamp;
};

type ImportLink = {
  id: string;
  device_code_digest: string;
  user_code: string;
  agent_label: string;
  environment_note: string;
  requested_cadence_minutes: number | null;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  expires_at: DatabaseTimestamp;
  interval_seconds: number;
  poll_count: number;
  last_polled_at: DatabaseTimestamp | null;
  approved_by_id: number | null;
  issued_token_id: string | null;
  created_at: DatabaseTimestamp;
};

type ImportRun = {
  id: string;
  project_id: string;
  user_id: number;
  token_id: string | null;
  agent_label: string;
  prompt_revision: number;
  prompt_snapshot: string;
  criteria_snapshot: JsonText;
  status: "queued" | "claimed" | "running" | "completed" | "failed" | "cancelled";
  lease_owner: string;
  lease_expires_at: DatabaseTimestamp | null;
  claim_token_digest: string;
  attempt_count: number;
  input_cursor: string;
  output_cursor: string;
  continuation: JsonText;
  result_counts: JsonText;
  summary: string;
  idempotency_key: string;
  created_at: DatabaseTimestamp;
  started_at: DatabaseTimestamp | null;
  completed_at: DatabaseTimestamp | null;
  updated_at: DatabaseTimestamp;
};

type ImportLead = {
  id: string;
  project_id: string;
  source: string;
  source_listing_id: string;
  canonical_url: string;
  identity_hash: string;
  source_url: string;
  title: string;
  summary: string;
  location: string;
  price_display: string;
  price_amount: string | null;
  price_currency: string;
  availability: string;
  housing_type: "entire" | "shared" | "unknown";
  date_confidence: "strong" | "verify" | "unknown";
  park_notes: string;
  attributes: JsonText;
  verification_notes: string;
  status: "active" | "trashed";
  trashed_by_id: number | null;
  trashed_at: DatabaseTimestamp | null;
  creator_id: number;
  revision: number;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
};

type ImportInterest = { lead_id: string; user_id: number; created_at: DatabaseTimestamp };

type ImportComment = {
  id: number;
  lead_id: string;
  author_id: number;
  parent_id: number | null;
  body: string;
  created_at: DatabaseTimestamp;
  edited_at: DatabaseTimestamp | null;
  deleted_at: DatabaseTimestamp | null;
};

type ImportChange = {
  id: number;
  project_id: string;
  sequence: number;
  event_type: string;
  object_type: string;
  object_id: string;
  payload: JsonText;
  tombstone: boolean;
  actor_id: number | null;
  actor_kind: string;
  token_id: string | null;
  occurred_at: DatabaseTimestamp;
};

type ImportReview = {
  id: string;
  project_id: string;
  user_id: number;
  reported_by_token_id: string | null;
  resolved_by_token_id: string | null;
  status: "open" | "resolved";
  observed_prompt_revision: number;
  resolved_prompt_revision: number | null;
  opened_at: DatabaseTimestamp;
  last_reported_at: DatabaseTimestamp;
  resolved_at: DatabaseTimestamp | null;
};

type ImportIdempotency = {
  id: number;
  user_id: number;
  token_id: string | null;
  endpoint: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: JsonText | null;
  expires_at: DatabaseTimestamp;
  created_at: DatabaseTimestamp;
};

type ImportAudit = {
  id: number;
  project_id: string | null;
  action: string;
  object_type: string;
  object_id: string;
  actor_kind: string;
  actor_id: number | null;
  token_id: string | null;
  request_id: string;
  summary: JsonText;
  created_at: DatabaseTimestamp;
};

export type ImportState = {
  users: ImportUser[];
  authThrottles: ImportThrottle[];
  savedPrompts: ImportSavedPrompt[];
  tokens: ImportToken[];
  links: ImportLink[];
  projects: ImportProject[];
  memberships: ImportMembership[];
  invitations: ImportInvitation[];
  promptRevisions: ImportPromptRevision[];
  searchRuns: ImportRun[];
  leads: ImportLead[];
  interests: ImportInterest[];
  comments: ImportComment[];
  changes: ImportChange[];
  reviews: ImportReview[];
  idempotencyKeys: ImportIdempotency[];
  auditEvents: ImportAudit[];
};

export type AuthorityRotationCounts = {
  agent_tokens: number;
  agent_links: number;
  auth_throttles: number;
  browser_sessions: number;
  idempotency_keys: number;
  project_changes: number;
  active_runs_cancelled: number;
  pending_invitations_reissue: number;
};

type Queryable =
  | postgres.Sql<LosslessMigrationValues>
  | postgres.TransactionSql<LosslessMigrationValues>;

function leadIdentity(urlValue: string): string {
  const url = new URL(urlValue);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || lower === "fbclid") url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return createHash("sha256").update(url.toString()).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function stateChecksum(value: ImportState): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(stableValue(value)));
  return hasher.digest("hex");
}

export function mismatchedStateTables(source: ImportState, target: ImportState): string[] {
  return (Object.keys(source) as (keyof ImportState)[]).filter(
    (key) => JSON.stringify(stableValue(source[key])) !== JSON.stringify(stableValue(target[key])),
  );
}

function normalizeState(state: ImportState): ImportState {
  const optionalNumber = (value: number | null): number | null =>
    value === null ? null : Number(value);
  return {
    ...state,
    users: state.users.map((user) => ({
      ...user,
      id: Number(user.id),
      email: user.email.trim().toLowerCase(),
    })),
    authThrottles: state.authThrottles.map((row) => ({
      ...row,
      failure_count: Number(row.failure_count),
    })),
    savedPrompts: state.savedPrompts.map((row) => ({
      ...row,
      id: Number(row.id),
      user_id: Number(row.user_id),
    })),
    tokens: state.tokens.map((token) => ({
      ...token,
      user_id: Number(token.user_id),
      expected_cadence_minutes: optionalNumber(token.expected_cadence_minutes),
    })),
    links: state.links.map((row) => ({
      ...row,
      requested_cadence_minutes: optionalNumber(row.requested_cadence_minutes),
      interval_seconds: Number(row.interval_seconds),
      poll_count: Number(row.poll_count),
      approved_by_id: optionalNumber(row.approved_by_id),
    })),
    projects: state.projects.map((project) => ({
      ...project,
      prompt_revision: Number(project.prompt_revision),
      latest_change_sequence: Number(project.latest_change_sequence),
      creator_id: Number(project.creator_id),
    })),
    memberships: state.memberships.map((row) => ({
      ...row,
      user_id: Number(row.user_id),
    })),
    invitations: state.invitations.map((invitation) => ({
      ...invitation,
      email: invitation.email.trim().toLowerCase(),
      inviter_id: Number(invitation.inviter_id),
    })),
    promptRevisions: state.promptRevisions.map((row) => ({
      ...row,
      id: Number(row.id),
      revision: Number(row.revision),
      editor_id: Number(row.editor_id),
    })),
    searchRuns: state.searchRuns.map((row) => ({
      ...row,
      user_id: Number(row.user_id),
      prompt_revision: Number(row.prompt_revision),
      attempt_count: Number(row.attempt_count),
    })),
    leads: state.leads.map((row) => ({
      ...row,
      trashed_by_id: optionalNumber(row.trashed_by_id),
      creator_id: Number(row.creator_id),
      revision: Number(row.revision),
    })),
    interests: state.interests.map((row) => ({ ...row, user_id: Number(row.user_id) })),
    comments: state.comments.map((row) => ({
      ...row,
      id: Number(row.id),
      author_id: Number(row.author_id),
      parent_id: optionalNumber(row.parent_id),
    })),
    changes: state.changes.map((row) => ({
      ...row,
      id: Number(row.id),
      sequence: Number(row.sequence),
      actor_id: optionalNumber(row.actor_id),
    })),
    reviews: state.reviews.map((row) => ({
      ...row,
      user_id: Number(row.user_id),
      observed_prompt_revision: Number(row.observed_prompt_revision),
      resolved_prompt_revision: optionalNumber(row.resolved_prompt_revision),
    })),
    idempotencyKeys: state.idempotencyKeys.map((row) => ({
      ...row,
      id: Number(row.id),
      user_id: Number(row.user_id),
      response_status: optionalNumber(row.response_status),
    })),
    auditEvents: state.auditEvents.map((row) => ({
      ...row,
      id: Number(row.id),
      actor_id: optionalNumber(row.actor_id),
    })),
  };
}

export function stateCounts(state: ImportState): Record<keyof ImportState, number> {
  return Object.fromEntries(
    Object.entries(state).map(([key, rows]) => [key, rows.length]),
  ) as Record<keyof ImportState, number>;
}

export function validateImportState(state: ImportState): void {
  if (!state.projects.length) throw new Error("Source contains no projects.");
  if (!state.users.length) throw new Error("Source contains no users.");
  const userIds = new Set(state.users.map((user) => user.id));
  const projectIds = new Set(state.projects.map((project) => project.id));
  const leadIds = new Set(state.leads.map((lead) => lead.id));
  const commentIds = new Map(state.comments.map((comment) => [comment.id, comment]));
  const tokenIds = new Set(state.tokens.map((token) => token.id));
  const leadIdentities = new Set<string>();
  const normalizedEmails = new Set<string>();
  const numericIds = [
    ...state.users.map((row) => row.id),
    ...state.savedPrompts.map((row) => row.id),
    ...state.promptRevisions.map((row) => row.id),
    ...state.comments.map((row) => row.id),
    ...state.auditEvents.map((row) => row.id),
  ];
  if (numericIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("Source contains an identifier outside JavaScript's safe integer range.");
  }

  for (const user of state.users) {
    const email = user.email.trim().toLowerCase();
    if (normalizedEmails.has(email))
      throw new Error("Source contains a normalized email collision.");
    normalizedEmails.add(email);
    if (!user.display_name.trim())
      throw new Error("Source contains a user without a profile name.");
    if (user.password_reset_required === isSupportedImportedHash(user.password_hash)) {
      throw new Error("Password reset marker does not match runtime hash support.");
    }
    if (user.is_active && user.password_reset_required) {
      throw new Error("Active user has no runtime-supported password hash.");
    }
  }
  for (const project of state.projects) {
    if (!userIds.has(project.creator_id)) throw new Error("Project creator is missing from users.");
    const memberships = state.memberships.filter(
      (membership) => membership.project_id === project.id,
    );
    if (!memberships.length || !memberships.some((membership) => membership.role === "owner")) {
      throw new Error("Project has no owner membership.");
    }
    if (
      !memberships.some(
        (membership) =>
          membership.role === "owner" &&
          state.users.some((user) => user.id === membership.user_id && user.is_active),
      )
    ) {
      throw new Error("Project has no active owner.");
    }
    const revisions = state.promptRevisions
      .filter((revision) => revision.project_id === project.id)
      .sort((left, right) => left.revision - right.revision);
    if (revisions.some((revision, index) => revision.revision !== index + 1)) {
      throw new Error("Project prompt revisions are not contiguous from one.");
    }
    if (
      project.prompt_revision > 0 &&
      !revisions.some((revision) => {
        if (revision.revision !== project.prompt_revision) return false;
        return (
          revision.prompt === project.prompt &&
          JSON.stringify(stableValue(revision.criteria)) ===
            JSON.stringify(stableValue(project.criteria))
        );
      })
    ) {
      throw new Error("Current prompt revision is missing or differs from project state.");
    }
  }
  for (const membership of state.memberships) {
    if (!projectIds.has(membership.project_id) || !userIds.has(membership.user_id)) {
      throw new Error("Membership references missing data.");
    }
  }
  for (const token of state.tokens) {
    const restrictedProjects = JSON.parse(token.project_ids) as unknown;
    if (
      !Array.isArray(restrictedProjects) ||
      !userIds.has(token.user_id) ||
      restrictedProjects.some((id) => typeof id !== "string" || !projectIds.has(id))
    ) {
      throw new Error("Agent token references missing access data.");
    }
  }
  for (const link of state.links) {
    if (link.approved_by_id && !userIds.has(link.approved_by_id)) {
      throw new Error("Agent link approver is missing.");
    }
    if (link.issued_token_id && !tokenIds.has(link.issued_token_id)) {
      throw new Error("Agent link token is missing.");
    }
  }
  for (const lead of state.leads) {
    if (!projectIds.has(lead.project_id) || !userIds.has(lead.creator_id)) {
      throw new Error("Lead references missing project or creator.");
    }
    if (lead.trashed_by_id && !userIds.has(lead.trashed_by_id)) {
      throw new Error("Lead trash actor is missing.");
    }
    const identity = `${lead.project_id}\u0000${lead.identity_hash}`;
    if (leadIdentities.has(identity)) {
      throw new Error("Leads collide under the TypeScript URL normalizer.");
    }
    leadIdentities.add(identity);
  }
  for (const interest of state.interests) {
    if (!leadIds.has(interest.lead_id) || !userIds.has(interest.user_id)) {
      throw new Error("Lead interest references missing data.");
    }
  }
  for (const comment of state.comments) {
    if (!leadIds.has(comment.lead_id) || !userIds.has(comment.author_id)) {
      throw new Error("Lead comment references missing data.");
    }
    const parent = comment.parent_id ? commentIds.get(comment.parent_id) : undefined;
    if (comment.parent_id && (!parent || parent.lead_id !== comment.lead_id)) {
      throw new Error("Lead comment parent is missing or belongs to another lead.");
    }
  }
  for (const comment of state.comments) {
    const seen = new Set<number>([comment.id]);
    let parentId = comment.parent_id;
    while (parentId) {
      if (seen.has(parentId)) throw new Error("Lead comment hierarchy contains a cycle.");
      seen.add(parentId);
      parentId = commentIds.get(parentId)?.parent_id ?? null;
    }
  }
  for (const run of state.searchRuns) {
    if (!projectIds.has(run.project_id) || !userIds.has(run.user_id)) {
      throw new Error("Search run references missing access data.");
    }
    if (run.token_id && !tokenIds.has(run.token_id))
      throw new Error("Search run token is missing.");
    if (
      run.agent_label.length > 160 ||
      run.summary.length > 10_000 ||
      run.claim_token_digest ||
      run.lease_owner ||
      run.lease_expires_at ||
      run.idempotency_key
    ) {
      throw new Error("Search run is not safe historical state.");
    }
  }
  for (const invitation of state.invitations) {
    if (!projectIds.has(invitation.project_id) || !userIds.has(invitation.inviter_id)) {
      throw new Error("Invitation references missing access data.");
    }
  }
  for (const row of [...state.changes, ...state.auditEvents]) {
    if (row.token_id && !tokenIds.has(row.token_id)) {
      throw new Error("History row references a missing token.");
    }
  }
  if (state.auditEvents.some((event) => event.request_id.length > 100)) {
    throw new Error("Audit request ID exceeds the target bound.");
  }
}

async function queryState(
  connection: Queryable,
  source: boolean,
  cutoverAt?: DatabaseTimestamp,
): Promise<ImportState> {
  const users = source
    ? await connection<ImportUser[]>`
        select u.id, u.email, u.password as password_hash,
               false as password_reset_required,
               u.last_login, u.is_staff,
               u.is_superuser, u.is_active, u.date_joined, u.updated_at, p.display_name,
               p.timezone, p.bio, p.personal_details,
               p.updated_at as profile_updated_at
          from accounts_user u
          join accounts_profile p on p.user_id = u.id
         order by u.id
      `
    : await connection<ImportUser[]>`
        select u.id, u.email, u.password_hash, u.password_reset_required, u.last_login,
               u.legacy_is_staff as is_staff,
               u.legacy_is_superuser as is_superuser, u.is_active, u.created_at as date_joined,
               u.updated_at, p.display_name, p.timezone, p.bio, p.personal_details,
               p.updated_at as profile_updated_at
          from users u join profiles p on p.user_id = u.id
         order by u.id
      `;
  const authThrottles = source
    ? []
    : await connection<ImportThrottle[]>`
        select key_digest, failure_count, window_started_at, blocked_until, updated_at
          from auth_throttles order by key_digest
      `;
  const savedPrompts = source
    ? await connection<ImportSavedPrompt[]>`
        select id, user_id, title, prompt, created_at, updated_at
          from accounts_savedprompt order by id
      `
    : await connection<ImportSavedPrompt[]>`
        select id, user_id, title, prompt, created_at, updated_at
          from saved_prompts order by id
      `;
  const tokens = source
    ? []
    : await connection<ImportToken[]>`
        select id::text, user_id, name, token_prefix, digest, scopes, project_ids,
               expected_cadence_minutes, environment_note, exposed_to_chat, expires_at,
               revoked_at, last_used_at, created_at
          from agent_tokens order by id
      `;
  const links = source
    ? []
    : await connection<ImportLink[]>`
        select id::text, device_code_digest, user_code, agent_label, environment_note,
               requested_cadence_minutes, status, expires_at, interval_seconds, poll_count,
               last_polled_at, approved_by_id, issued_token_id::text, created_at
          from agent_links order by id
      `;
  const projects = source
    ? await connection<ImportProject[]>`
        select id::text, name, slug, description, prompt, criteria, status, prompt_revision,
               0::bigint as latest_change_sequence, creator_id, created_at, updated_at
          from projects_project order by id
      `
    : await connection<ImportProject[]>`
        select id::text, name, slug, description, current_prompt as prompt, criteria, status,
               prompt_revision, latest_change_sequence, creator_id, created_at, updated_at
          from projects order by id
      `;
  const memberships = source
    ? await connection<ImportMembership[]>`
        select project_id::text, user_id, role, joined_at
          from projects_projectmembership order by project_id, user_id
      `
    : await connection<ImportMembership[]>`
        select project_id::text, user_id, role, joined_at
          from project_memberships order by project_id, user_id
      `;
  const rawInvitations = source
    ? await connection<ImportInvitation[]>`
        select id::text, project_id::text, invited_email as email, role, inviter_id,
               ''::text as token_digest,
               expires_at, accepted_at,
               case
                 when accepted_at is null and revoked_at is null and
                      expires_at > ${cutoverAt as string}::timestamptz
                   then ${cutoverAt as string}::timestamptz
                 else revoked_at
               end as revoked_at,
               created_at
          from projects_projectinvitation order by id
      `
    : await connection<ImportInvitation[]>`
        select id::text, project_id::text, email, role, inviter_id, token_digest, expires_at,
               accepted_at, revoked_at, created_at
          from project_invitations order by id
      `;
  const invitations = source
    ? rawInvitations.map((invitation) => ({
        ...invitation,
        token_digest: `legacy:${invitation.id.replaceAll("-", "")}`,
      }))
    : rawInvitations;
  const promptRevisions = source
    ? await connection<ImportPromptRevision[]>`
        select id, project_id::text, revision, prompt, criteria, editor_id, created_at
          from projects_promptrevision order by id
      `
    : await connection<ImportPromptRevision[]>`
        select id, project_id::text, revision, prompt, criteria, editor_id, created_at
          from prompt_revisions order by id
      `;
  const rawRuns = source
    ? await connection<ImportRun[]>`
        select id::text, project_id::text, user_id, null::text as token_id, agent_label,
               prompt_revision, prompt_snapshot, criteria_snapshot, status, lease_owner,
               lease_expires_at, ''::text as claim_token_digest, attempt_count,
               input_cursor, output_cursor,
               continuation, result_counts, summary, idempotency_key, created_at, started_at,
               completed_at, updated_at
          from projects_searchrun order by id
      `
    : await connection<ImportRun[]>`
        select id::text, project_id::text, user_id, token_id::text, agent_label, prompt_revision,
               prompt_snapshot, criteria_snapshot, status, lease_owner, lease_expires_at,
               claim_token_digest, attempt_count, input_cursor, output_cursor, continuation,
               result_counts, summary, idempotency_key, created_at, started_at, completed_at,
               updated_at
          from search_runs order by id
      `;
  const searchRuns: ImportRun[] = source
    ? (rawRuns as ImportRun[]).map((run) => ({
        ...run,
        status: ["queued", "claimed", "running"].includes(run.status) ? "cancelled" : run.status,
        lease_owner: "",
        lease_expires_at: null,
        claim_token_digest: "",
        idempotency_key: "",
      }))
    : (rawRuns as ImportRun[]);
  const rawLeads = source
    ? await connection<ImportLead[]>`
        select id::text, project_id::text, source, source_listing_id, canonical_url, identity_hash,
               source_url, title, summary, location, price_display, price_amount, price_currency,
               availability, housing_type, date_confidence, park_notes, attributes,
               verification_notes, status, trashed_by_id, trashed_at, creator_id, revision,
               created_at, updated_at
          from projects_lead order by id
      `
    : await connection<ImportLead[]>`
        select id::text, project_id::text, source, source_listing_id, canonical_url, identity_hash,
               source_url, title, summary, location, price_display, price_amount, price_currency,
               availability, housing_type, date_confidence, park_notes, attributes,
               verification_notes, status, trashed_by_id, trashed_at, creator_id, revision,
               created_at, updated_at
          from leads order by id
      `;
  const leads = source
    ? rawLeads.map((lead) => ({ ...lead, identity_hash: leadIdentity(lead.canonical_url) }))
    : rawLeads;
  const interests = source
    ? await connection<ImportInterest[]>`
        select lead_id::text, user_id, created_at from projects_leadinterest order by lead_id, user_id
      `
    : await connection<ImportInterest[]>`
        select lead_id::text, user_id, created_at from lead_interests order by lead_id, user_id
      `;
  const comments = source
    ? await connection<ImportComment[]>`
        select id, lead_id::text, author_id, parent_id, body, created_at, edited_at, deleted_at
          from projects_leadcomment order by id
      `
    : await connection<ImportComment[]>`
        select id, lead_id::text, author_id, parent_id, body, created_at, edited_at, deleted_at
          from lead_comments order by id
      `;
  const changes = source
    ? []
    : await connection<ImportChange[]>`
        select id, project_id::text, sequence, event_type, object_type, object_id, payload,
               tombstone, actor_id, actor_kind, token_id::text, occurred_at
          from project_changes order by id
      `;
  const reviews = source
    ? await connection<ImportReview[]>`
        select id::text, project_id::text, user_id, null::text as reported_by_token_id,
               null::text as resolved_by_token_id, status,
               observed_prompt_revision, resolved_prompt_revision, opened_at, last_reported_at,
               resolved_at from projects_sourceplanreview order by id
      `
    : await connection<ImportReview[]>`
        select id::text, project_id::text, user_id, reported_by_token_id::text,
               resolved_by_token_id::text, status, observed_prompt_revision,
               resolved_prompt_revision, opened_at, last_reported_at, resolved_at
          from source_plan_reviews order by id
      `;
  const idempotencyKeys = source
    ? []
    : await connection<ImportIdempotency[]>`
        select id, user_id, token_id::text, endpoint, key, request_hash, response_status,
               response_body, expires_at, created_at from idempotency_keys order by id
      `;
  const auditEvents = source
    ? await connection<ImportAudit[]>`
        select id, project_id::text, action, object_type, object_id, actor_kind, actor_id,
               null::text as token_id, request_id, summary, created_at
          from projects_auditevent order by id
      `
    : await connection<ImportAudit[]>`
        select id, project_id::text, action, object_type, object_id, actor_kind, actor_id,
               token_id::text, request_id, summary, created_at
          from audit_events order by id
      `;

  return normalizeState({
    users: source
      ? users.map((user) => ({
          ...user,
          password_reset_required: !isSupportedImportedHash(user.password_hash),
        }))
      : users,
    authThrottles,
    savedPrompts,
    tokens,
    links,
    projects,
    memberships,
    invitations,
    promptRevisions,
    searchRuns,
    leads,
    interests,
    comments,
    changes,
    reviews,
    idempotencyKeys,
    auditEvents,
  });
}

export async function readDjangoState(
  sourceUrl: string,
  cutoverAt: DatabaseTimestamp,
): Promise<ImportState> {
  if (Number.isNaN(new Date(cutoverAt).getTime())) {
    throw new Error("Migration cutover time is invalid.");
  }
  const source = createMigrationClient(sourceUrl);
  try {
    return await source.begin(async (transaction) => {
      await transaction`set transaction isolation level repeatable read, read only`;
      await transaction`set local time zone 'UTC'`;
      const state = await queryState(transaction, true, cutoverAt);
      const [sourceCounts] = await transaction<{ profiles: number; users: number }[]>`
        select (select count(*)::int from accounts_user) as users,
               (select count(*)::int from accounts_profile) as profiles
      `;
      if (
        sourceCounts?.users !== state.users.length ||
        sourceCounts.profiles !== state.users.length
      ) {
        throw new Error("Every Django user must have exactly one imported profile.");
      }
      validateImportState(state);
      return state;
    });
  } finally {
    await source.end({ timeout: 5 });
  }
}

export async function readDjangoRotationCounts(
  sourceUrl: string,
  cutoverAt: DatabaseTimestamp,
): Promise<AuthorityRotationCounts> {
  const source = createMigrationClient(sourceUrl);
  try {
    const [counts] = await source<AuthorityRotationCounts[]>`
      select
        (select count(*)::int from accounts_agenttoken) as agent_tokens,
        (select count(*)::int from accounts_agentlink) as agent_links,
        (select count(*)::int from accounts_auththrottle) as auth_throttles,
        (select count(*)::int from django_session) as browser_sessions,
        (select count(*)::int from projects_idempotencykey) as idempotency_keys,
        (select count(*)::int from projects_projectchange) as project_changes,
        (select count(*)::int from projects_searchrun
          where status in ('queued', 'claimed', 'running')) as active_runs_cancelled,
        (select count(*)::int from projects_projectinvitation
          where accepted_at is null and revoked_at is null and expires_at > ${cutoverAt})
          as pending_invitations_reissue
    `;
    if (!counts) throw new Error("Could not inventory rotated Django authority.");
    return counts;
  } finally {
    await source.end({ timeout: 5 });
  }
}

export async function readTypeScriptState(connection: Queryable): Promise<ImportState> {
  const state = await queryState(connection, false);
  validateImportState(state);
  return state;
}
