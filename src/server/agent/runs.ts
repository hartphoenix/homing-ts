import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Hono } from "hono";

import {
  conflict,
  forbidden,
  methodNotAllowed,
  notFound,
  unauthorized,
  validation,
} from "./errors";

export type AgentPrincipal = {
  userId: number;
  tokenId?: string | null;
  scopes?: readonly string[] | ReadonlySet<string>;
  projectIds?: readonly string[];
};

export function hasScope(principal: AgentPrincipal, scope: string): boolean {
  if (!principal.scopes) return true;
  if (typeof (principal.scopes as { has?: unknown }).has === "function")
    return (principal.scopes as ReadonlySet<string>).has(scope);
  return [...(principal.scopes as readonly string[])].includes(scope);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

export type ProjectSnapshot = {
  id: string;
  promptRevision: number;
  promptSnapshot: string;
  criteriaSnapshot: Record<string, unknown>;
  feedEpoch?: string;
};

export type RunStatus = "queued" | "claimed" | "running" | "completed" | "failed" | "cancelled";
export type LaneStatus =
  | "ok"
  | "empty"
  | "blocked"
  | "error"
  | "skipped"
  | "skipped_needs_local"
  | "skipped_needs_human";
export type ContinuationNext = "broaden_radius" | "narrow_price" | "next_page" | "done";

export type LaneContinuation = {
  lane: string;
  status: LaneStatus;
  covered_through?: string;
  items_seen?: number;
  items_new?: number;
};

export type Continuation = {
  worker?: string;
  protocol?: number;
  deferred_batches?: number;
  lanes?: LaneContinuation[];
  lanes_owned?: string[];
  needs_local?: string[];
  needs_human?: string[];
  next?: ContinuationNext;
};

export type ResultCounts = Record<string, number>;

export type SearchRun = {
  id: string;
  projectId: string;
  userId: number;
  tokenId: string | null;
  agentLabel: string;
  promptRevision: number;
  promptSnapshot: string;
  criteriaSnapshot: Record<string, unknown>;
  status: RunStatus;
  leaseOwner: string;
  leaseExpiresAt: Date | null;
  claimTokenDigest: string;
  attemptCount: number;
  inputCursor: string;
  outputCursor: string;
  continuation: Continuation;
  resultCounts: ResultCounts;
  summary: string;
  idempotencyKey: string;
  createdAt: Date;
  completedAt: Date | null;
};

export type RunCreateRequest = {
  projectId: string;
  userId: number;
  tokenId: string | null;
  agentLabel: string;
  inputCursor: string;
  continuationFromRunId?: string;
  idempotencyKey: string;
  snapshot: ProjectSnapshot;
};

export type RunCompletion = {
  claimToken: string;
  status: "completed" | "failed";
  outputCursor: string;
  continuation: Continuation;
  resultCounts: ResultCounts;
  summary: string;
  idempotencyKey: string;
};

export type RunListOptions = { limit: number; cursor?: string; agentLabelPrefix?: string };

export type DecodedRunCursor = { createdAt: Date; id: string };

export function encodeRunCursor(run: Pick<SearchRun, "createdAt" | "id">): string {
  return Buffer.from(`${run.createdAt.toISOString()}|${run.id}`, "utf8").toString("base64url");
}

export function decodeRunCursor(raw: string): DecodedRunCursor {
  try {
    if (!raw || raw.length > 400) throw new Error("invalid");
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    const stamp = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    const createdAt = new Date(stamp);
    if (separator < 1 || !isUuid(id) || Number.isNaN(createdAt.getTime()))
      throw new Error("invalid");
    return { createdAt, id };
  } catch {
    throw validation("cursor must be an opaque cursor");
  }
}

export interface RunRepository {
  snapshotProject(projectId: string, principal: AgentPrincipal): Promise<ProjectSnapshot | null>;
  create(request: RunCreateRequest): Promise<{ run: SearchRun; replayed: boolean }>;
  list(
    projectId: string,
    options: RunListOptions,
    principal: AgentPrincipal,
  ): Promise<{ runs: SearchRun[]; nextCursor: string | null }>;
  get(projectId: string, runId: string, principal: AgentPrincipal): Promise<SearchRun | null>;
  claim(
    projectId: string,
    runId: string,
    principal: AgentPrincipal,
    now: Date,
  ): Promise<{ run: SearchRun; claimToken: string }>;
  heartbeat(
    projectId: string,
    runId: string,
    principal: AgentPrincipal,
    claimToken: string,
    now: Date,
  ): Promise<SearchRun>;
  complete(
    projectId: string,
    runId: string,
    principal: AgentPrincipal,
    completion: RunCompletion,
    now: Date,
  ): Promise<{ run: SearchRun; replayed: boolean }>;
}

export type ProjectAuthorizer = (
  principal: AgentPrincipal,
  projectId: string,
  scope: string,
) => Promise<void> | void;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw validation(`${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

function slug(value: unknown, name: string, max = 80): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /\s/.test(value)) {
    throw validation(`${name} must be 1 to ${max} characters without whitespace`);
  }
  return value;
}

const laneStatuses = new Set<LaneStatus>([
  "ok",
  "empty",
  "blocked",
  "error",
  "skipped",
  "skipped_needs_local",
  "skipped_needs_human",
]);
const continuationNext = new Set<ContinuationNext>([
  "broaden_radius",
  "narrow_price",
  "next_page",
  "done",
]);
const continuationKeys = new Set([
  "worker",
  "protocol",
  "deferred_batches",
  "lanes",
  "lanes_owned",
  "needs_local",
  "needs_human",
  "next",
  "next_query",
]);
const laneKeys = new Set(["lane", "status", "covered_through", "items_seen", "items_new"]);
const resultKeys = new Set([
  "created",
  "updated",
  "unchanged",
  "conflicts",
  "trashed",
  "restored",
  "sources_ok",
  "sources_blocked",
  "suspected_injection",
  "urls_refused",
]);
const isoTimestamp = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function validateContinuation(value: unknown): {
  continuation: Continuation;
  deprecatedNextQuery: boolean;
} {
  if (value === undefined || value === null)
    return { continuation: {}, deprecatedNextQuery: false };
  if (!isObject(value)) throw validation("continuation must be an object");
  const unknown = Object.keys(value).filter((key) => !continuationKeys.has(key));
  if (unknown.length)
    throw validation(`continuation rejects unknown fields: ${unknown.sort().join(", ")}`);
  const out: Continuation = {};
  if ("worker" in value) {
    if (typeof value.worker !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.worker))
      throw validation("continuation.worker must be a lowercase worker slug");
    out.worker = value.worker;
  }
  if ("protocol" in value)
    out.protocol = boundedInteger(value.protocol, "continuation.protocol", 16);
  if ("deferred_batches" in value)
    out.deferred_batches = boundedInteger(
      value.deferred_batches,
      "continuation.deferred_batches",
      10_000,
    );
  if ("next" in value) {
    if (typeof value.next !== "string" || !continuationNext.has(value.next as ContinuationNext))
      throw validation("continuation.next is invalid");
    out.next = value.next as ContinuationNext;
  }
  for (const key of ["lanes_owned", "needs_local", "needs_human"] as const) {
    if (!(key in value)) continue;
    if (!Array.isArray(value[key]) || value[key].length > 40)
      throw validation(`continuation.${key} must contain at most 40 lanes`);
    out[key] = value[key].map((entry) => {
      if (
        typeof entry !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,39}$/.test(entry)
      )
        throw validation(`continuation.${key}[] must be a source:channel slug`);
      return entry;
    });
  }
  if ("lanes" in value) {
    if (!Array.isArray(value.lanes) || value.lanes.length > 40)
      throw validation("continuation.lanes must contain at most 40 entries");
    out.lanes = value.lanes.map((raw, index) => {
      if (!isObject(raw)) throw validation(`continuation.lanes[${index}] must be an object`);
      const fields = Object.keys(raw).filter((key) => !laneKeys.has(key));
      if (fields.length)
        throw validation(
          `continuation.lanes[${index}] rejects unknown fields: ${fields.sort().join(", ")}`,
        );
      const status = raw.status;
      if (typeof status !== "string" || !laneStatuses.has(status as LaneStatus))
        throw validation(`continuation.lanes[${index}].status is invalid`);
      if (
        typeof raw.lane !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,39}$/.test(raw.lane)
      )
        throw validation(`continuation.lanes[${index}].lane must be a source:channel slug`);
      const lane: LaneContinuation = { lane: raw.lane, status: status as LaneStatus };
      if ("covered_through" in raw) {
        lane.covered_through = slug(
          raw.covered_through,
          `continuation.lanes[${index}].covered_through`,
          64,
        );
        if (!isoTimestamp.test(lane.covered_through))
          throw validation(`continuation.lanes[${index}].covered_through must be ISO-8601`);
      }
      if ("items_seen" in raw)
        lane.items_seen = boundedInteger(
          raw.items_seen,
          `continuation.lanes[${index}].items_seen`,
          1_000_000,
        );
      if ("items_new" in raw)
        lane.items_new = boundedInteger(
          raw.items_new,
          `continuation.lanes[${index}].items_new`,
          1_000_000,
        );
      return lane;
    });
  }
  return { continuation: out, deprecatedNextQuery: "next_query" in value };
}

export function validateResultCounts(value: unknown): ResultCounts {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw validation("result_counts must be an object");
  const unknown = Object.keys(value).filter((key) => !resultKeys.has(key));
  if (unknown.length)
    throw validation(`result_counts rejects unknown fields: ${unknown.sort().join(", ")}`);
  const result = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, boundedInteger(value[key], `result_counts.${key}`, 1_000_000)]),
  );
  if ((result.trashed ?? 0) !== 0 || (result.restored ?? 0) !== 0)
    throw validation("paired agents may not report destructive writes");
  return result;
}

function serializeRun(run: SearchRun) {
  return {
    id: run.id,
    project_id: run.projectId,
    status: run.status,
    agent_label: run.agentLabel,
    prompt_revision: run.promptRevision,
    prompt_snapshot: run.promptSnapshot,
    criteria_snapshot: run.criteriaSnapshot,
    lease_expires_at: run.leaseExpiresAt?.toISOString() ?? null,
    attempt_count: run.attemptCount,
    input_cursor: run.inputCursor,
    output_cursor: run.outputCursor,
    continuation: run.continuation,
    result_counts: run.resultCounts,
    summary: run.summary,
    created_at: run.createdAt.toISOString(),
    completed_at: run.completedAt?.toISOString() ?? null,
  };
}

export class RunService {
  constructor(
    private readonly repository: RunRepository,
    private readonly authorize?: ProjectAuthorizer,
  ) {}

  async check(
    principal: AgentPrincipal | null,
    projectId: string,
    scope: string,
  ): Promise<AgentPrincipal> {
    if (!principal) throw unauthorized();
    if (!isUuid(projectId)) throw notFound();
    if (!hasScope(principal, scope)) throw forbidden(`The token does not have ${scope}.`);
    if (principal.projectIds?.length && !principal.projectIds.includes(projectId)) throw notFound();
    await this.authorize?.(principal, projectId, scope);
    return principal;
  }

  async create(
    projectId: string,
    principal: AgentPrincipal,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ) {
    const snapshot = await this.repository.snapshotProject(projectId, principal);
    if (!snapshot) throw notFound();
    const agentLabel = input.agent_label;
    if (typeof agentLabel !== "string" || agentLabel.length < 1 || agentLabel.length > 120)
      throw validation("agent_label must be 1 to 120 characters");
    const inputCursor = input.input_cursor ?? "";
    if (typeof inputCursor !== "string" || inputCursor.length > 2000)
      throw validation("input_cursor must be at most 2000 characters");
    if (
      input.continuation_from_run_id !== undefined &&
      (typeof input.continuation_from_run_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          input.continuation_from_run_id,
        ))
    )
      throw validation("continuation_from_run_id must be a UUID");
    const request: RunCreateRequest = {
      projectId,
      userId: principal.userId,
      tokenId: principal.tokenId ?? null,
      agentLabel,
      inputCursor,
      idempotencyKey,
      snapshot,
    };
    if (typeof input.continuation_from_run_id === "string")
      request.continuationFromRunId = input.continuation_from_run_id;
    const created = await this.repository.create(request);
    return { body: serializeRun(created.run), status: 201 };
  }

  async list(projectId: string, principal: AgentPrincipal, search: URLSearchParams) {
    const limitRaw = search.get("limit");
    const limit = Math.min(Math.max(limitRaw ? Number(limitRaw) : 20, 1), 100);
    if (!Number.isInteger(limit)) throw validation("limit must be an integer");
    const prefix = (search.get("agent_label_prefix") ?? "").slice(0, 160);
    const options: RunListOptions = { limit };
    const cursor = search.get("cursor");
    if (cursor) options.cursor = cursor;
    if (prefix) options.agentLabelPrefix = prefix;
    const result = await this.repository.list(projectId, options, principal);
    return {
      items: result.runs.map(serializeRun),
      next_cursor: result.nextCursor,
      ordering: "-created_at",
    };
  }

  async detail(projectId: string, runId: string, principal: AgentPrincipal) {
    if (!isUuid(runId)) throw notFound();
    const run = await this.repository.get(projectId, runId, principal);
    if (!run) throw notFound();
    return serializeRun(run);
  }

  async claim(projectId: string, runId: string, principal: AgentPrincipal) {
    if (!isUuid(runId)) throw notFound();
    const claimed = await this.repository.claim(projectId, runId, principal, new Date());
    return {
      claim_token: claimed.claimToken,
      lease_expires_at: claimed.run.leaseExpiresAt?.toISOString() ?? null,
    };
  }

  async heartbeat(
    projectId: string,
    runId: string,
    principal: AgentPrincipal,
    input: Record<string, unknown>,
  ) {
    if (!isUuid(runId)) throw notFound();
    if (typeof input.claim_token !== "string" || !input.claim_token)
      throw validation("claim_token is required");
    const run = await this.repository.heartbeat(
      projectId,
      runId,
      principal,
      input.claim_token,
      new Date(),
    );
    return { lease_expires_at: run.leaseExpiresAt?.toISOString() ?? null, status: run.status };
  }

  async complete(
    projectId: string,
    runId: string,
    principal: AgentPrincipal,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ) {
    if (!isUuid(runId)) throw notFound();
    if (typeof input.claim_token !== "string" || !input.claim_token)
      throw validation("claim_token is required");
    if (input.status !== "completed" && input.status !== "failed")
      throw validation("status must be completed or failed");
    if (typeof idempotencyKey !== "string" || !idempotencyKey)
      throw validation("Idempotency-Key is required when completing a run");
    const continuation = validateContinuation(input.continuation).continuation;
    const resultCounts = validateResultCounts(input.result_counts);
    const outputCursor = input.output_cursor ?? "";
    const summary = input.summary ?? "";
    if (typeof outputCursor !== "string" || outputCursor.length > 2000)
      throw validation("output_cursor must be at most 2000 characters");
    if (typeof summary !== "string") throw validation("summary must be text");
    const cleanSummary = [...summary]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return !(
          code <= 0x08 ||
          code === 0x0b ||
          code === 0x0c ||
          (code >= 0x0e && code <= 0x1f) ||
          code === 0x7f
        );
      })
      .join("")
      .replace(/\r/g, " ")
      .slice(0, 1000)
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
      .replace(/[<>]/g, "");
    const result = await this.repository.complete(
      projectId,
      runId,
      principal,
      {
        claimToken: input.claim_token,
        status: input.status,
        outputCursor,
        continuation,
        resultCounts,
        summary: cleanSummary,
        idempotencyKey,
      },
      new Date(),
    );
    const deprecated = validateContinuation(input.continuation).deprecatedNextQuery;
    return { body: serializeRun(result.run), deprecated };
  }
}

export class InMemoryRunRepository implements RunRepository {
  readonly runs = new Map<string, SearchRun>();
  readonly projects = new Map<string, ProjectSnapshot>();
  private readonly createKeys = new Map<string, { hash: string; runId: string }>();
  private readonly completionKeys = new Map<string, { hash: string; runId: string }>();

  seedProject(snapshot: ProjectSnapshot) {
    this.projects.set(snapshot.id, snapshot);
  }

  async snapshotProject(projectId: string): Promise<ProjectSnapshot | null> {
    return this.projects.get(projectId) ?? null;
  }

  async create(request: RunCreateRequest) {
    const key = request.idempotencyKey
      ? `${request.projectId}:${request.userId}:${request.tokenId ?? "session"}:${request.idempotencyKey}`
      : "";
    const hash = digest({
      agentLabel: request.agentLabel,
      inputCursor: request.inputCursor,
      continuationFromRunId: request.continuationFromRunId,
    });
    if (key && this.createKeys.has(key)) {
      const prior = this.createKeys.get(key) as { hash: string; runId: string };
      if (prior.hash !== hash)
        throw conflict(
          "idempotency_key_reused",
          "The idempotency key was already used with a different request.",
        );
      return { run: this.runs.get(prior.runId) as SearchRun, replayed: true };
    }
    const now = new Date();
    const run: SearchRun = {
      id: randomUUID(),
      projectId: request.projectId,
      userId: request.userId,
      tokenId: request.tokenId,
      agentLabel: request.agentLabel,
      promptRevision: request.snapshot.promptRevision,
      promptSnapshot: request.snapshot.promptSnapshot,
      criteriaSnapshot: request.snapshot.criteriaSnapshot,
      status: "queued",
      leaseOwner: "",
      leaseExpiresAt: null,
      claimTokenDigest: "",
      attemptCount: 0,
      inputCursor: request.inputCursor,
      outputCursor: "",
      continuation: {},
      resultCounts: {},
      summary: "",
      idempotencyKey: request.idempotencyKey,
      createdAt: now,
      completedAt: null,
    };
    this.runs.set(run.id, run);
    if (key) this.createKeys.set(key, { hash, runId: run.id });
    return { run, replayed: false };
  }

  async list(projectId: string, options: RunListOptions) {
    const cursor = options.cursor ? decodeRunCursor(options.cursor) : null;
    const rows = [...this.runs.values()]
      .filter(
        (run) =>
          run.projectId === projectId &&
          (!options.agentLabelPrefix || run.agentLabel.startsWith(options.agentLabelPrefix)) &&
          (!cursor ||
            run.createdAt < cursor.createdAt ||
            (run.createdAt.getTime() === cursor.createdAt.getTime() && run.id < cursor.id)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const hasMore = rows.length > options.limit;
    const runs = rows.slice(0, options.limit);
    return {
      runs,
      nextCursor:
        hasMore && runs.length ? encodeRunCursor(runs[runs.length - 1] as SearchRun) : null,
    };
  }

  async get(projectId: string, runId: string) {
    const run = this.runs.get(runId);
    return run?.projectId === projectId ? run : null;
  }

  private runFor(projectId: string, runId: string) {
    const run = this.runs.get(runId);
    if (!run || run.projectId !== projectId) throw notFound();
    return run;
  }

  async claim(projectId: string, runId: string, principal: AgentPrincipal, now: Date) {
    const run = this.runFor(projectId, runId);
    const active = [...this.runs.values()].some(
      (other) =>
        other.projectId === projectId &&
        other.id !== runId &&
        (other.status === "claimed" || other.status === "running") &&
        !!other.leaseExpiresAt &&
        other.leaseExpiresAt > now,
    );
    if (active) throw conflict("run_already_claimed", "Another run holds the project lease.");
    if (["completed", "failed", "cancelled"].includes(run.status))
      throw conflict("run_not_claimable", "Run is already finished.");
    const claimToken = randomBytes(32).toString("base64url");
    run.status = "claimed";
    run.leaseOwner = `${principal.userId}:${principal.tokenId ?? "session"}`;
    run.leaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    run.claimTokenDigest = digest(claimToken);
    run.attemptCount += 1;
    return { run, claimToken };
  }

  async heartbeat(
    projectId: string,
    runId: string,
    _principal: AgentPrincipal,
    claimToken: string,
    now: Date,
  ) {
    const run = this.runFor(projectId, runId);
    if (
      run.claimTokenDigest !== digest(claimToken) ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= now
    )
      throw conflict("invalid_claim", "Claim token is invalid or expired.");
    run.status = "running";
    run.leaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    return run;
  }

  async complete(
    projectId: string,
    runId: string,
    _principal: AgentPrincipal,
    completion: RunCompletion,
    now: Date,
  ) {
    const run = this.runFor(projectId, runId);
    const key = `${_principal.userId}:${_principal.tokenId ?? "session"}:${projectId}:${runId}:${completion.idempotencyKey}`;
    const requestHash = digest(completion);
    const prior = this.completionKeys.get(key);
    if (prior) {
      if (prior.hash !== requestHash)
        throw conflict(
          "idempotency_key_reused",
          "The idempotency key was already used with a different request.",
        );
      return { run: this.runFor(projectId, prior.runId), replayed: true };
    }
    const same =
      run.status === completion.status &&
      run.outputCursor === completion.outputCursor &&
      digest(run.continuation) === digest(completion.continuation) &&
      digest(run.resultCounts) === digest(completion.resultCounts) &&
      run.summary === completion.summary;
    if (run.status === "completed" || run.status === "failed") {
      if (!same)
        throw conflict(
          "idempotency_key_reused",
          "The run was already completed with a different payload.",
        );
      this.completionKeys.set(key, { hash: requestHash, runId });
      return { run, replayed: true };
    }
    if (
      run.claimTokenDigest !== digest(completion.claimToken) ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= now
    )
      throw conflict("invalid_claim", "Claim token is invalid or expired.");
    run.status = completion.status;
    run.outputCursor = completion.outputCursor;
    run.continuation = completion.continuation;
    run.resultCounts = completion.resultCounts;
    run.summary = completion.summary;
    run.completedAt = now;
    run.leaseExpiresAt = null;
    this.completionKeys.set(key, { hash: requestHash, runId });
    return { run, replayed: false };
  }
}

function parseBody(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw validation("JSON object required");
  return value;
}

export type RunRouterOptions = {
  service: RunService;
  principal: (request: Request) => Promise<AgentPrincipal | null> | AgentPrincipal | null;
};

export function createRunRouter(options: RunRouterOptions): Hono {
  const app = new Hono();
  const principalFor = (request: Request) => options.principal(request);
  app.all("/projects/:projectId/search-runs", async (c) => {
    const principal = await options.service.check(
      await principalFor(c.req.raw),
      c.req.param("projectId"),
      c.req.method === "GET" ? "projects:read" : "runs:write",
    );
    if (c.req.method === "GET")
      return c.json(
        await options.service.list(
          c.req.param("projectId"),
          principal,
          new URL(c.req.url).searchParams,
        ),
      );
    if (c.req.method !== "POST") throw methodNotAllowed("GET or POST");
    const body = parseBody(await c.req.json().catch(() => null));
    const result = await options.service.create(
      c.req.param("projectId"),
      principal,
      body,
      c.req.header("Idempotency-Key")?.slice(0, 200) ?? "",
    );
    return c.json(result.body, result.status as 200 | 201);
  });
  app.get("/projects/:projectId/search-runs/:runId", async (c) => {
    const principal = await options.service.check(
      await principalFor(c.req.raw),
      c.req.param("projectId"),
      "projects:read",
    );
    return c.json(
      await options.service.detail(c.req.param("projectId"), c.req.param("runId"), principal),
    );
  });
  app.post("/projects/:projectId/search-runs/:runId/claim", async (c) => {
    const principal = await options.service.check(
      await principalFor(c.req.raw),
      c.req.param("projectId"),
      "runs:write",
    );
    return c.json(
      await options.service.claim(c.req.param("projectId"), c.req.param("runId"), principal),
    );
  });
  app.post("/projects/:projectId/search-runs/:runId/heartbeat", async (c) => {
    const principal = await options.service.check(
      await principalFor(c.req.raw),
      c.req.param("projectId"),
      "runs:write",
    );
    return c.json(
      await options.service.heartbeat(
        c.req.param("projectId"),
        c.req.param("runId"),
        principal,
        parseBody(await c.req.json().catch(() => null)),
      ),
    );
  });
  app.post("/projects/:projectId/search-runs/:runId/complete", async (c) => {
    const principal = await options.service.check(
      await principalFor(c.req.raw),
      c.req.param("projectId"),
      "runs:write",
    );
    const body = parseBody(await c.req.json().catch(() => null));
    const result = await options.service.complete(
      c.req.param("projectId"),
      c.req.param("runId"),
      principal,
      body,
      c.req.header("Idempotency-Key")?.slice(0, 200) ?? "",
    );
    if (result.deprecated)
      c.header(
        "X-Homing-Deprecation",
        "ignored continuation fields: next_query; they will be rejected",
      );
    return c.json(result.body);
  });
  return app;
}

export { serializeRun };
