import { createHmac } from "node:crypto";
import { Hono } from "hono";
import {
  AGENT_TOKEN_DAYS,
  DEVICE_LINK_INTERVAL_SECONDS,
  DEVICE_LINK_MAX_POLLS,
  DEVICE_LINK_TTL_SECONDS,
  digestOpaque,
  newUserCode,
  randomOpaque,
} from "../../auth/crypto";
import {
  type AuthContext,
  type AuthRouterDependencies,
  type AuthVariables,
  requireSession,
  resolvePrincipal,
} from "../../auth/router";
import { HomingError } from "../../http";
import { etagForSha256 } from "./canonical";
import { normalizeUuid } from "./identities";
import type { V2ProjectSummary, V2Repository, V2RunRecord } from "./repository";
import {
  protocolVersionSchema,
  v2PairingRequestSchema,
  v2PauseSchema,
  v2WireConfigCreateSchema,
  v2WireDeliverySchema,
  v2WireRunCreateSchema,
} from "./schemas";
import { V2_INITIAL_SCOPES } from "./scopes";
import { V2Service } from "./service";

export type V2RouterDependencies = {
  repository: V2Repository;
  auth: AuthRouterDependencies;
  now?: () => Date;
};

type V2Context = AuthContext;

function nowOf(deps: V2RouterDependencies): Date {
  return deps.now?.() ?? deps.auth.now?.() ?? new Date();
}

function requestIdOf(context: V2Context): string {
  try {
    return context.get("requestId") || context.req.header("X-Request-ID") || "";
  } catch {
    return context.req.header("X-Request-ID") || "";
  }
}

function errorResponse(context: V2Context, error: unknown): Response {
  const typed =
    error instanceof HomingError
      ? error
      : new HomingError("server_error", "The request could not be completed.", 500);
  const response = context.json(
    {
      error: {
        code: typed.code,
        message: typed.message,
        fields: typed.fields,
        request_id: requestIdOf(context),
      },
    },
    typed.status,
  );
  const headers = (typed as HomingError & { headers?: Record<string, string> }).headers;
  for (const [name, value] of Object.entries(headers ?? {})) response.headers.set(name, value);
  return response;
}

function withErrors(
  handler: (context: V2Context, next: () => Promise<void>) => Promise<Response | undefined>,
) {
  return async (context: V2Context, next: () => Promise<void>): Promise<Response | undefined> => {
    try {
      return await handler(context, next);
    } catch (error) {
      return errorResponse(context, error);
    }
  };
}

async function jsonBody(context: V2Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new HomingError("validation_error", "Request body must be valid JSON.", 422);
  }
}

async function fallThrough(next: () => Promise<void>): Promise<undefined> {
  await next();
  return undefined;
}

function parseBody<T>(
  schema: {
    safeParse: (value: unknown) => {
      success: boolean;
      data?: T;
      error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
    };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new HomingError("validation_error", "The request body is invalid.", 422, {
      issues:
        parsed.error?.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })) ?? [],
    });
  }
  return parsed.data;
}

function pathUuid(context: V2Context, name: string): string {
  try {
    return normalizeUuid(context.req.param(name) ?? "", `${name} must be a UUID`);
  } catch {
    throw new HomingError("not_found", "Object not found.", 404);
  }
}

function throttleDigest(deps: AuthRouterDependencies, kind: string, value: string): string {
  const key = deps.throttleKey ?? "homing-auth-throttle-key-not-for-production";
  return createHmac("sha256", key).update(`auth-throttle:${kind}:${value}`, "utf8").digest("hex");
}

function address(context: V2Context, deps: AuthRouterDependencies): string {
  return (
    deps.clientAddress?.(context) ||
    context.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim() ||
    "unknown"
  );
}

async function startPairing(context: V2Context, deps: V2RouterDependencies) {
  const body = parseBody(v2PairingRequestSchema, await jsonBody(context));
  const now = nowOf(deps);
  const deviceCode = randomOpaque();
  const base = {
    deviceCodeDigest: digestOpaque(deviceCode),
    agentLabel: body.agent_label,
    environmentNote: body.environment_note ?? "",
    requestedCadenceMinutes: body.requested_cadence_minutes ?? null,
    expiresAt: new Date(now.getTime() + DEVICE_LINK_TTL_SECONDS * 1_000),
    intervalSeconds: DEVICE_LINK_INTERVAL_SECONDS,
    protocolVersion: "v2" as const,
  };
  let link = null;
  for (let attempt = 0; attempt < 8 && !link; attempt += 1) {
    link = await deps.auth.repo.createAgentLink({ ...base, userCode: newUserCode() });
  }
  if (!link)
    throw new HomingError("conflict", "Could not allocate a pairing code. Try again.", 409);
  const verificationUri = `${deps.auth.origin}/link/`;
  return context.json(
    {
      protocol_version: 2,
      device_code: deviceCode,
      user_code: link.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(link.userCode)}`,
      expires_in: DEVICE_LINK_TTL_SECONDS,
      interval: link.intervalSeconds,
    },
    201,
  );
}

function linkFailure(
  context: V2Context,
  code: string,
  message: string,
  retryAfter?: number,
): Response {
  const error = new HomingError(code, message, 400);
  if (retryAfter !== undefined)
    (error as HomingError & { headers?: Record<string, string> }).headers = {
      "Retry-After": String(retryAfter),
    };
  return errorResponse(context, error);
}

async function pollPairing(context: V2Context, deps: V2RouterDependencies) {
  const body = await jsonBody(context);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HomingError("validation_error", "Request body must be a JSON object.", 422);
  }
  const record = body as Record<string, unknown>;
  const deviceCode = typeof record.device_code === "string" ? record.device_code : "";
  if (!deviceCode || deviceCode.length > 256)
    return linkFailure(context, "access_denied", "This pairing was not approved.");
  const existing = await deps.auth.repo.getAgentLinkByDigest(digestOpaque(deviceCode));
  if (existing?.protocolVersion !== "v2") return null;
  const poll = await deps.auth.repo.pollAgentLink(
    digestOpaque(deviceCode),
    nowOf(deps),
    DEVICE_LINK_MAX_POLLS,
  );
  const link = poll.link;
  if (poll.outcome === "access_denied" || !link)
    return linkFailure(context, "access_denied", "This pairing was not approved.");
  if (poll.outcome === "slow_down")
    return linkFailure(
      context,
      "slow_down",
      `Poll no more than once every ${link.intervalSeconds} seconds.`,
      link.intervalSeconds,
    );
  if (poll.outcome === "expired_token")
    return linkFailure(context, "expired_token", "This pairing request expired.");
  if (poll.outcome === "authorization_pending")
    return linkFailure(
      context,
      "authorization_pending",
      "Waiting for approval in Homing.",
      link.intervalSeconds,
    );
  if (poll.outcome !== "approved" || link.approvedById === null)
    return linkFailure(context, "access_denied", "This pairing was not approved.");
  const user = await deps.auth.repo.findUserById(link.approvedById);
  if (!user?.isActive)
    return linkFailure(context, "access_denied", "This pairing was not approved.");
  const now = nowOf(deps);
  const raw = randomOpaque();
  const generated = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: link.agentLabel || "paired v2 agent",
    tokenPrefix: raw.slice(0, 12),
    digest: digestOpaque(raw),
    scopes: [...V2_INITIAL_SCOPES],
    projectIds: [],
    expectedCadenceMinutes: link.requestedCadenceMinutes,
    environmentNote: link.environmentNote,
    exposedToChat: false,
    sourceWriteExpiresAt: new Date(now.getTime() + 30 * 60_000),
    expiresAt: new Date(now.getTime() + (deps.auth.tokenDays ?? AGENT_TOKEN_DAYS) * 86_400_000),
  };
  const issued = await deps.auth.repo.consumeApprovedAgentLink(link.id, user.id, generated);
  if (!issued) return linkFailure(context, "access_denied", "This pairing was already used.");
  return context.json({
    protocol_version: 2,
    connection_id: issued.id,
    token: raw,
    expires_at: issued.expiresAt.toISOString(),
    scopes: issued.scopes,
    source_write_expires_at: issued.sourceWriteExpiresAt?.toISOString() ?? null,
  });
}

function runJson(run: V2RunRecord) {
  return {
    id: run.id,
    invocation_id: run.invocationId,
    agent_label: run.agentLabel,
    status: run.status,
    phase: run.phase,
    projects: run.projects.map((project) => ({
      project_id: project.projectId,
      prompt_revision_id: project.promptRevisionId,
      prompt_revision: project.promptRevision,
      canonical_sha256: project.canonicalSha256,
      queries: project.queries.map((query) => ({
        source_query_revision_id: query.sourceQueryRevisionId,
        source_query_revision: query.sourceQueryRevision,
        canonical_sha256: query.canonicalSha256,
      })),
    })),
    report: run.report,
  };
}

function binaryRevision(context: V2Context, bytes: Uint8Array, hash: string): Response {
  const tag = etagForSha256(hash);
  if (context.req.header("If-None-Match") === tag)
    return new Response(null, { status: 304, headers: { ETag: tag } });
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ETag: tag,
      "Cache-Control": "private, no-store",
    },
  });
}

export function createV2Router(deps: V2RouterDependencies) {
  const router = new Hono<{ Variables: AuthVariables }>();
  const service = new V2Service(deps.repository);

  router.post(
    "/agent-link",
    withErrors(async (context, next) => {
      let raw: unknown;
      try {
        raw = await context.req.raw.clone().json();
      } catch {
        return fallThrough(next);
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallThrough(next);
      const marker = (raw as Record<string, unknown>).protocol_version;
      if (!protocolVersionSchema.safeParse(marker).success) return fallThrough(next);
      const digest = throttleDigest(deps.auth, "pairing-ip", address(context, deps.auth));
      const throttle = await deps.auth.repo.consumeThrottle([digest], nowOf(deps), 10, 15 * 60_000);
      if (throttle.blocked) {
        const error = new HomingError(
          "rate_limited",
          "Too many pairing attempts. Try again later.",
          429,
        );
        (error as HomingError & { headers?: Record<string, string> }).headers = {
          "Retry-After": String(Math.max(1, throttle.retryAfter)),
        };
        throw error;
      }
      return startPairing(context, deps);
    }),
  );

  router.post(
    "/agent-link/token",
    withErrors(async (context, next) => {
      const result = await pollPairing(context, deps);
      if (result) return result;
      await next();
    }),
  );

  router.get(
    "/me/token",
    withErrors(async (context, next) => {
      const principal = await resolvePrincipal(context, deps.auth);
      if (
        principal.kind !== "agent" ||
        !principal.token?.scopes.some((scope) => scope === "agent-config:read")
      ) {
        await next();
        return;
      }
      const profile = await deps.auth.repo.findProfileByUserId(principal.user.id);
      return context.json({
        protocol_version: 2,
        id: principal.token.id,
        connection_id: principal.token.id,
        expires_at: principal.token.expiresAt.toISOString(),
        scopes: principal.token.scopes,
        source_write_expires_at: principal.token.sourceWriteExpiresAt?.toISOString() ?? null,
        agent_paused_until: profile?.agentPausedUntil?.toISOString() ?? null,
      });
    }),
  );

  router.get(
    "/agent/projects",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      const token =
        principal.kind === "agent" ? service.requireScope(principal, "agent-config:read") : null;
      const profile = await deps.auth.repo.findProfileByUserId(principal.user.id);
      const projects = await deps.repository.listProjects(principal.user.id);
      return context.json({
        protocol_version: 2,
        agent_paused_until: profile?.agentPausedUntil?.toISOString() ?? null,
        paused_until: profile?.agentPausedUntil?.toISOString() ?? null,
        projects: projects.map((project: V2ProjectSummary) => ({
          project_id: project.id,
          name: project.name,
          slug: project.slug,
          config_status: project.configStatus,
          current_config_revision: project.configRevision,
          config_revision: project.configRevision,
          config_sha256: project.configSha256,
          required_evidence: project.requiredEvidence,
          source_queries: project.sourceQueries,
          latest_run: project.latestRun,
          paused_until: project.pausedUntil?.toISOString() ?? null,
        })),
        scopes: token?.scopes ?? [],
      });
    }),
  );

  router.post(
    "/projects/:project/config-revisions",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      const token = service.requireSourceWrite(principal, nowOf(deps));
      const body = parseBody(v2WireConfigCreateSchema, await jsonBody(context));
      const revision = await service.createConfig(
        principal.user.id,
        pathUuid(context, "project"),
        body,
      );
      return context.json(
        {
          id: revision.id,
          project_id: revision.projectId,
          revision: revision.revision,
          config_status: revision.status,
          canonical_sha256: revision.canonicalSha256,
          required_evidence: revision.requiredEvidence,
          source_query_ids: revision.sourceQueryIds,
          source_write_expires_at: token.sourceWriteExpiresAt?.toISOString() ?? null,
        },
        201,
      );
    }),
  );

  router.get(
    "/projects/:project/config-revisions/:revision",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      service.requireScope(principal, "agent-config:read");
      const revision = Number(context.req.param("revision"));
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new HomingError("not_found", "Object not found.", 404);
      const value = await service.getConfig(
        principal.user.id,
        pathUuid(context, "project"),
        revision,
      );
      if (!value) throw new HomingError("not_found", "Object not found.", 404);
      return binaryRevision(context, value.canonicalBytes, value.canonicalSha256);
    }),
  );

  router.get(
    "/projects/:project/source-query-revisions/:query",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      service.requireScope(principal, "agent-config:read");
      const value = await service.getSourceQuery(
        principal.user.id,
        pathUuid(context, "project"),
        pathUuid(context, "query"),
      );
      if (!value) throw new HomingError("not_found", "Object not found.", 404);
      return binaryRevision(context, value.canonicalBytes, value.canonicalSha256);
    }),
  );

  router.post(
    "/agent-runs",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      const token = service.requireScope(principal, "agent-runs:write");
      const body = parseBody(v2WireRunCreateSchema, await jsonBody(context));
      const result = await service.createRun(principal.user.id, token.id, token.name, body);
      return context.json(runJson(result.run), result.replayed ? 200 : 201);
    }),
  );

  router.patch(
    "/agent-runs/:run",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      const token = service.requireScope(principal, "agent-runs:write");
      const runId = pathUuid(context, "run");
      const result = await service.finalizeRun(
        principal.user.id,
        token.id,
        runId,
        await jsonBody(context),
      );
      return context.json(runJson(result.run));
    }),
  );

  router.post(
    "/projects/:project/leads/create-or-return-existing",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      const token = service.requireScope(principal, "agent-deliveries:write");
      const body = parseBody(v2WireDeliverySchema, await jsonBody(context));
      const result = await service.deliver(
        principal.user.id,
        token.id,
        pathUuid(context, "project"),
        body,
      );
      return context.json(
        {
          ...result,
          outcome: result.status,
          lead_id: result.leadId,
          observation_id: result.observationId,
        },
        result.status === "created" ? 201 : 200,
      );
    }),
  );

  router.put(
    "/me/agent-pause",
    withErrors(async (context) => {
      const principal = await requireSession(context, deps.auth, true);
      const body = parseBody(v2PauseSchema, await jsonBody(context));
      const now = nowOf(deps);
      let pausedUntil: Date | null;
      if (body.paused !== undefined)
        pausedUntil = body.paused ? new Date(now.getTime() + 14 * 86_400_000) : null;
      else pausedUntil = body.paused_until ? new Date(body.paused_until) : null;
      if (
        pausedUntil &&
        (pausedUntil <= now || pausedUntil.getTime() > now.getTime() + 14 * 86_400_000)
      ) {
        throw new HomingError(
          "validation_error",
          "paused_until must be within the next 14 days.",
          422,
        );
      }
      const profile = await deps.auth.repo.updateProfile(
        principal.user.id,
        { agentPausedUntil: pausedUntil },
        now,
      );
      if (!profile) throw new HomingError("not_found", "Object not found.", 404);
      return context.json({ paused_until: profile.agentPausedUntil?.toISOString() ?? null });
    }),
  );

  router.post(
    "/auth/tokens/:connection/source-refresh",
    withErrors(async (context) => {
      const principal = await requireSession(context, deps.auth, true);
      const connection = pathUuid(context, "connection");
      const refreshed = await deps.repository.grantSourceWrite(
        principal.user.id,
        connection,
        nowOf(deps),
      );
      if (!refreshed) throw new HomingError("not_found", "Object not found.", 404);
      return context.json({
        connection_id: refreshed.id,
        scopes: refreshed.scopes,
        source_write_expires_at: refreshed.sourceWriteExpiresAt?.toISOString() ?? null,
      });
    }),
  );

  router.post(
    "/me/token/finalize-setup",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      const token = service.requireScope(principal, "connection:self");
      const finalized = await deps.repository.finalizeSourceWrite(token.id, nowOf(deps));
      if (!finalized) throw new HomingError("not_found", "Object not found.", 404);
      return context.json({
        connection_id: finalized.id,
        scopes: finalized.scopes,
        source_write_expires_at: null,
      });
    }),
  );

  router.delete(
    "/me/token",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps.auth);
      const token = service.requireScope(principal, "connection:self");
      const revoked = await deps.auth.repo.revokeToken(principal.user.id, token.id, nowOf(deps));
      if (!revoked) throw new HomingError("not_found", "Object not found.", 404);
      return new Response(null, { status: 204 });
    }),
  );

  return router;
}

export type V2Router = ReturnType<typeof createV2Router>;
