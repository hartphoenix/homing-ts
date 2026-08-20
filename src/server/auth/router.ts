import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { HomingError } from "../http";
import { isBoundedJson } from "../json-limits";
import {
  AGENT_TOKEN_DAYS,
  DEVICE_LINK_INTERVAL_SECONDS,
  DEVICE_LINK_MAX_POLLS,
  DEVICE_LINK_TTL_SECONDS,
  digestOpaque,
  equalOpaque,
  newUserCode,
  normalizeUserCode,
  randomOpaque,
  SESSION_COOKIE,
  SESSION_DAYS,
} from "./crypto";
import { hashPassword, verifyPassword } from "./password";
import type { AuthRepository } from "./repository";
import { AGENT_SCOPES, normalizeScopes, PAIRED_AGENT_SCOPES } from "./scopes";
import type {
  AgentLinkRecord,
  AgentTokenRecord,
  AuthProfile,
  AuthUser,
  CreateAgentLinkInput,
  CreateSessionInput,
  CreateTokenInput,
  Principal,
} from "./types";

export type AuthVariables = {
  requestId: string;
  principal: Principal;
};
export type AuthContext = Context<{ Variables: AuthVariables }>;

export type AuthRouterDependencies = {
  repo: AuthRepository;
  origin: string;
  sessionDays?: number;
  tokenDays?: number;
  /** AUTH_THROTTLE_KEY; never expose or log it. */
  throttleKey?: string;
  clientAddress?: (context: AuthContext) => string;
  now?: () => Date;
};

class AuthHttpError extends HomingError {
  readonly headers: Record<string, string>;

  constructor(
    code: string,
    message: string,
    status: ContentfulStatusCode,
    fields: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(code, message, status, fields);
    this.name = "AuthHttpError";
    this.headers = headers;
  }
}

function nowOf(deps: AuthRouterDependencies): Date {
  return deps.now?.() ?? new Date();
}

function throttleDigest(deps: AuthRouterDependencies, kind: string, value: string): string {
  const key = deps.throttleKey ?? "homing-auth-throttle-key-not-for-production";
  return createHmac("sha256", key).update(`auth-throttle:${kind}:${value}`, "utf8").digest("hex");
}

function clientAddress(context: AuthContext, deps: AuthRouterDependencies): string {
  return (
    deps.clientAddress?.(context) ||
    context.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim() ||
    "unknown"
  );
}

async function consumeThrottle(
  deps: AuthRouterDependencies,
  keys: Array<[kind: string, value: string]>,
  limit: number,
  windowMs: number,
): Promise<void> {
  const digests = keys.map(([kind, value]) => throttleDigest(deps, kind, value));
  const result = await deps.repo.consumeThrottle(digests, nowOf(deps), limit, windowMs);
  if (result.blocked) {
    throw new AuthHttpError(
      "rate_limited",
      "Too many authentication attempts. Try again later.",
      429,
      {},
      { "Retry-After": String(Math.max(1, result.retryAfter)) },
    );
  }
}

async function resetThrottle(
  deps: AuthRouterDependencies,
  keys: Array<[kind: string, value: string]>,
): Promise<void> {
  await deps.repo.resetThrottle(
    keys.map(([kind, value]) => throttleDigest(deps, kind, value)),
    nowOf(deps),
  );
}

function requestIdOf(context: AuthContext): string {
  try {
    return context.get("requestId") || context.req.header("X-Request-ID") || "";
  } catch {
    return context.req.header("X-Request-ID") || "";
  }
}

function errorResponse(
  context: AuthContext,
  error: HomingError,
  headers: Record<string, string> = {},
): Response {
  const response = context.json(
    {
      error: {
        code: error.code,
        message: error.message,
        fields: error.fields,
        request_id: requestIdOf(context),
      },
    },
    error.status,
  );
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

function withErrors(
  handler: (context: AuthContext) => Promise<Response>,
): (context: AuthContext) => Promise<Response> {
  return async (context) => {
    try {
      return await handler(context);
    } catch (error) {
      if (error instanceof AuthHttpError) return errorResponse(context, error, error.headers);
      if (error instanceof HomingError) return errorResponse(context, error);
      return errorResponse(
        context,
        new HomingError("server_error", "The request could not be completed.", 500),
      );
    }
  };
}

function authChallenge(origin: string): string {
  return `Bearer realm="homing", error="invalid_token", resource_metadata="${origin}/agent/"`;
}

function unauthorized(origin: string, bearer = false): never {
  throw new AuthHttpError(
    "unauthorized",
    "Authentication is required.",
    401,
    {},
    bearer ? { "WWW-Authenticate": authChallenge(origin) } : {},
  );
}

function requireExactOrigin(context: AuthContext, deps: AuthRouterDependencies): void {
  if (context.req.header("Origin") !== deps.origin) {
    throw new HomingError("csrf_failed", "A valid Origin is required.", 403);
  }
}

function setSessionCookie(context: AuthContext, raw: string, maxAge: number): void {
  setCookie(context, SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

function clearSessionCookie(context: AuthContext): void {
  deleteCookie(context, SESSION_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
}

async function parseJson(context: AuthContext): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    throw new HomingError("validation_error", "Request body must be a JSON object.", 422);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HomingError("validation_error", "Request body must be a JSON object.", 422);
  }
  return value as Record<string, unknown>;
}

function normalizedEmail(value: unknown): string {
  const email = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new HomingError("validation_error", "email must be a valid email address.", 422);
  }
  return email;
}

function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function userJson(
  user: AuthUser,
  profile: Awaited<ReturnType<AuthRepository["findProfileByUserId"]>>,
) {
  return {
    id: user.id,
    email: user.email,
    display_name: profile?.displayName ?? "",
    is_active: user.isActive,
  };
}

function profileJson(
  profile: NonNullable<Awaited<ReturnType<AuthRepository["findProfileByUserId"]>>>,
) {
  return {
    id: profile.userId,
    display_name: profile.displayName,
    timezone: profile.timezone,
    bio: profile.bio,
    details: profile.personalDetails,
    agent_paused_until: iso(profile.agentPausedUntil),
  };
}

function tokenMetadata(token: AgentTokenRecord) {
  return {
    id: token.id,
    name: token.name,
    prefix: token.tokenPrefix,
    scopes: token.scopes,
    project_ids: token.projectIds,
    expires_at: token.expiresAt.toISOString(),
    revoked_at: iso(token.revokedAt),
  };
}

async function sessionFromCookie(context: AuthContext, deps: AuthRouterDependencies) {
  const raw = getCookie(context, SESSION_COOKIE);
  if (!raw || raw.length > 256) return null;
  const session = await deps.repo.getSession(digestOpaque(raw));
  if (!session || session.expiresAt <= nowOf(deps)) return null;
  return { raw, session };
}

export async function resolvePrincipal(
  context: AuthContext,
  deps: AuthRouterDependencies,
): Promise<Principal> {
  const authorization = context.req.header("Authorization");
  if (authorization !== undefined) {
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    const bearer = match?.[1];
    if (!bearer || bearer.length > 256) unauthorized(deps.origin, true);
    const token = await deps.repo.getTokenByDigest(digestOpaque(bearer));
    const now = nowOf(deps);
    if (!token || token.revokedAt || token.expiresAt <= now) unauthorized(deps.origin, true);
    const user = await deps.repo.findUserById(token.userId);
    if (!user?.isActive) unauthorized(deps.origin, true);
    await deps.repo.touchToken(token.id, now);
    token.lastUsedAt = now;
    return {
      kind: "agent",
      user,
      token,
      scopes: token.scopes,
    };
  }

  const cookieSession = await sessionFromCookie(context, deps);
  if (!cookieSession?.session.userId) unauthorized(deps.origin);
  const user = await deps.repo.findUserById(cookieSession.session.userId);
  if (!user?.isActive) unauthorized(deps.origin);
  return {
    kind: "session",
    user,
    token: null,
    scopes: AGENT_SCOPES,
    sessionDigest: digestOpaque(cookieSession.raw),
  };
}

export async function assertSessionMutation(
  context: AuthContext,
  deps: AuthRouterDependencies,
): Promise<void> {
  requireExactOrigin(context, deps);
  const cookieSession = await sessionFromCookie(context, deps);
  const provided = context.req.header("X-CSRF-Token");
  if (!cookieSession || !provided || provided.length > 256 || !provided.trim()) {
    throw new HomingError("csrf_failed", "A valid CSRF token is required.", 403);
  }
  if (!equalOpaque(digestOpaque(provided), cookieSession.session.csrfDigest)) {
    throw new HomingError("csrf_failed", "A valid CSRF token is required.", 403);
  }
}

export async function requireSession(
  context: AuthContext,
  deps: AuthRouterDependencies,
  mutation = false,
): Promise<Principal> {
  const principal = await resolvePrincipal(context, deps);
  if (principal.kind !== "session") {
    throw new HomingError("forbidden", "This operation requires an authenticated session.", 403);
  }
  if (mutation) await assertSessionMutation(context, deps);
  return principal;
}

function requireAgentScope(principal: Principal, scope: (typeof AGENT_SCOPES)[number]): void {
  if (principal.kind === "agent" && !principal.scopes.includes(scope)) {
    throw new HomingError("forbidden", "Token lacks the required scope.", 403);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function projectIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new HomingError(
      "validation_error",
      "project_ids must be an array of at most 100 UUIDs.",
      422,
    );
  }
  const ids = value.map((item) => String(item));
  if (ids.some((id) => !UUID_PATTERN.test(id))) {
    throw new HomingError("validation_error", "project_ids must contain UUIDs.", 422);
  }
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

function cadence(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_080) {
    throw new HomingError(
      "validation_error",
      "requested_cadence_minutes must be between 1 and 10080.",
      422,
    );
  }
  return value;
}

function checkedScopes(value: unknown, paired = false) {
  try {
    return normalizeScopes(value, paired);
  } catch {
    throw new HomingError("validation_error", "scopes must contain only known scopes.", 422);
  }
}

async function tokenValue(
  deps: AuthRouterDependencies,
  userId: number,
  input: {
    name: string;
    scopes: string[];
    projectIds?: string[];
    expiresAt?: Date;
    expectedCadenceMinutes?: number | null;
    environmentNote?: string;
    exposedToChat?: boolean;
    paired?: boolean;
  },
): Promise<{ input: CreateTokenInput; raw: string }> {
  const raw = randomOpaque();
  const now = nowOf(deps);
  const maximumExpiry = new Date(now.getTime() + (deps.tokenDays ?? AGENT_TOKEN_DAYS) * 86_400_000);
  const token: CreateTokenInput = {
    id: crypto.randomUUID(),
    userId,
    name: input.name,
    tokenPrefix: raw.slice(0, 12),
    digest: digestOpaque(raw),
    scopes: checkedScopes(input.scopes, input.paired),
    projectIds: input.projectIds ?? [],
    expectedCadenceMinutes: input.expectedCadenceMinutes ?? null,
    environmentNote: input.environmentNote ?? "",
    exposedToChat: input.exposedToChat ?? false,
    expiresAt: input.expiresAt ?? maximumExpiry,
  };
  if (token.name.trim() === "" || token.name.length > 120) {
    throw new HomingError("validation_error", "name must be between 1 and 120 characters.", 422);
  }
  if (token.environmentNote.length > 200) {
    throw new HomingError("validation_error", "environment_note is too long.", 422);
  }
  if (token.exposedToChat && token.scopes.includes("leads:destroy")) {
    throw new HomingError("validation_error", "exposed tokens cannot trash or restore leads.", 422);
  }
  if (token.expiresAt <= now || token.expiresAt > maximumExpiry) {
    throw new HomingError(
      "validation_error",
      "expires_at must be in the future and within the allowed token lifetime.",
      422,
    );
  }
  return { input: token, raw };
}

async function issueToken(
  deps: AuthRouterDependencies,
  userId: number,
  input: Parameters<typeof tokenValue>[2],
): Promise<{ token: AgentTokenRecord; raw: string }> {
  const generated = await tokenValue(deps, userId, input);
  return { token: await deps.repo.createToken(generated.input), raw: generated.raw };
}

function linkError(code: string, message: string, retryAfter?: number): HomingError {
  return new AuthHttpError(
    code,
    message,
    400,
    {},
    retryAfter === undefined ? {} : { "Retry-After": String(retryAfter) },
  );
}

/** Approval is intentionally a service hook for the browser/link UI owned by another slice. */
export async function approveDeviceLink(
  repo: AuthRepository,
  userCode: string,
  userId: number,
  at = new Date(),
): Promise<boolean> {
  return repo.decideAgentLink(normalizeUserCode(userCode), userId, "approved", at);
}

export async function denyDeviceLink(
  repo: AuthRepository,
  userCode: string,
  userId: number,
  at = new Date(),
): Promise<boolean> {
  return repo.decideAgentLink(normalizeUserCode(userCode), userId, "denied", at);
}

export function createAuthRouter(deps: AuthRouterDependencies) {
  const router = new Hono<{ Variables: AuthVariables }>();

  router.get(
    "/csrf",
    withErrors(async (context) => {
      const now = nowOf(deps);
      const existing = await sessionFromCookie(context, deps);
      const csrf = randomOpaque();
      const csrfDigest = digestOpaque(csrf);
      if (existing) {
        const valid = await deps.repo.updateSessionCsrf(digestOpaque(existing.raw), csrfDigest);
        if (valid) {
          return context.json({ csrf_token: csrf });
        }
      }
      const rawSession = randomOpaque();
      const input: CreateSessionInput = {
        digest: digestOpaque(rawSession),
        userId: null,
        csrfDigest,
        expiresAt: new Date(now.getTime() + (deps.sessionDays ?? SESSION_DAYS) * 86_400_000),
      };
      await deps.repo.createSession(input);
      setSessionCookie(context, rawSession, (deps.sessionDays ?? SESSION_DAYS) * 86_400);
      return context.json({ csrf_token: csrf });
    }),
  );

  router.post(
    "/invitations/:token/register",
    withErrors(async (context) => {
      await assertSessionMutation(context, deps);
      const body = await parseJson(context);
      const invitationToken = context.req.param("token");
      if (!invitationToken || invitationToken.length > 256) {
        throw new HomingError("registration_disabled", "An active invitation is required.", 403);
      }
      const now = nowOf(deps);
      const invitationDigest = digestOpaque(invitationToken);
      const invitation = await deps.repo.findPendingInvitation(invitationDigest, now);
      if (!invitation) throw new HomingError("not_found", "Object not found.", 404);

      const address = clientAddress(context, deps);
      const email = normalizedEmail(body.email);
      const throttleKeys: Array<[kind: string, value: string]> = [
        ["ip", address],
        ["email", email],
      ];
      await consumeThrottle(deps, throttleKeys, 5, 15 * 60_000);
      const displayName = String(body.display_name ?? "").trim();
      const password = String(body.password ?? "");
      if (
        email !== invitation.email ||
        !displayName ||
        displayName.length > 120 ||
        password.length < 12 ||
        password.length > 4096
      ) {
        throw new HomingError(
          "registration_unavailable",
          "Unable to register with these details.",
          422,
        );
      }
      const passwordHash = await hashPassword(password);
      const registration = await deps.repo.registerInvitedUser({
        invitationDigest,
        email,
        displayName,
        passwordHash,
        now,
      });
      if (!registration) {
        throw new HomingError(
          "registration_unavailable",
          "Unable to register with these details.",
          422,
        );
      }
      const { user } = registration;
      const oldSession = await sessionFromCookie(context, deps);
      if (!oldSession) throw new HomingError("csrf_failed", "A valid CSRF token is required.", 403);
      const rawSession = randomOpaque();
      const rawCsrf = randomOpaque();
      await deps.repo.completeLogin(
        digestOpaque(oldSession.raw),
        {
          digest: digestOpaque(rawSession),
          userId: user.id,
          csrfDigest: digestOpaque(rawCsrf),
          expiresAt: new Date(now.getTime() + (deps.sessionDays ?? SESSION_DAYS) * 86_400_000),
        },
        user.id,
      );
      await resetThrottle(deps, throttleKeys);
      setSessionCookie(context, rawSession, (deps.sessionDays ?? SESSION_DAYS) * 86_400);
      return context.json(
        {
          user: { id: user.id, email: user.email, display_name: displayName },
          project_id: registration.projectId,
          csrf_token: rawCsrf,
        },
        201,
      );
    }),
  );

  router.get(
    "/invitations/:token/accept",
    withErrors(async (context) => {
      const token = context.req.param("token");
      if (!token || token.length > 256)
        throw new HomingError("not_found", "Object not found.", 404);
      const invitation = await deps.repo.findPendingInvitation(digestOpaque(token), nowOf(deps));
      if (!invitation) throw new HomingError("not_found", "Object not found.", 404);
      return context.json({
        email: invitation.email,
        role: invitation.role,
        project: { id: invitation.projectId, name: invitation.projectName },
        inviter_name: invitation.inviterName,
        expires_at: invitation.expiresAt.toISOString(),
      });
    }),
  );

  router.post(
    "/invitations/:token/accept",
    withErrors(async (context) => {
      const principal = await requireSession(context, deps, true);
      const token = context.req.param("token");
      if (!token || token.length > 256)
        throw new HomingError("not_found", "Object not found.", 404);
      const projectId = await deps.repo.acceptInvitation(
        digestOpaque(token),
        principal.user.id,
        nowOf(deps),
      );
      if (!projectId) throw new HomingError("not_found", "Object not found.", 404);
      return context.json({ project_id: projectId });
    }),
  );

  router.post(
    "/session",
    withErrors(async (context) => {
      await assertSessionMutation(context, deps);
      const address = clientAddress(context, deps);
      let body: Record<string, unknown>;
      try {
        body = await parseJson(context);
      } catch (error) {
        await consumeThrottle(deps, [["ip", address]], 5, 15 * 60_000);
        throw error;
      }
      let email: string;
      try {
        email = normalizedEmail(body.email);
      } catch (error) {
        await consumeThrottle(deps, [["ip", address]], 5, 15 * 60_000);
        throw error;
      }
      const throttleKeys: Array<[kind: string, value: string]> = [
        ["ip", address],
        ["email", email],
      ];
      await consumeThrottle(deps, throttleKeys, 5, 15 * 60_000);
      const password = String(body.password ?? "");
      if (!password || password.length > 4096) {
        throw new HomingError("unauthorized", "Invalid credentials.", 401);
      }
      const oldSession = await sessionFromCookie(context, deps);
      const user = await deps.repo.findUserByEmail(email);
      const check =
        user?.isActive && !user.passwordResetRequired
          ? await verifyPassword(password, user.passwordHash)
          : { valid: false };
      if (!user?.isActive || user.passwordResetRequired || !check.valid) {
        throw new HomingError("unauthorized", "Invalid credentials.", 401);
      }
      await resetThrottle(deps, throttleKeys);
      const now = nowOf(deps);
      const rawSession = randomOpaque();
      const rawCsrf = randomOpaque();
      const input: CreateSessionInput = {
        digest: digestOpaque(rawSession),
        userId: user.id,
        csrfDigest: digestOpaque(rawCsrf),
        expiresAt: new Date(now.getTime() + (deps.sessionDays ?? SESSION_DAYS) * 86_400_000),
      };
      if (!oldSession) throw new HomingError("csrf_failed", "A valid CSRF token is required.", 403);
      await deps.repo.completeLogin(digestOpaque(oldSession.raw), input, user.id, check.rehash);
      setSessionCookie(context, rawSession, (deps.sessionDays ?? SESSION_DAYS) * 86_400);
      return context.json({ user: { id: user.id, email: user.email }, csrf_token: rawCsrf });
    }),
  );

  router.delete(
    "/session",
    withErrors(async (context) => {
      await assertSessionMutation(context, deps);
      const current = await sessionFromCookie(context, deps);
      if (!current) unauthorized(deps.origin);
      await deps.repo.deleteSession(digestOpaque(current.raw));
      clearSessionCookie(context);
      return new Response(null, { status: 204 });
    }),
  );

  router.get(
    "/me",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps);
      requireAgentScope(principal, "profile:read");
      const profile = await deps.repo.findProfileByUserId(principal.user.id);
      return context.json({
        user: userJson(principal.user, profile),
        profile: profile ? profileJson(profile) : null,
      });
    }),
  );

  router.get(
    "/me/profile",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps);
      requireAgentScope(principal, "profile:read");
      const profile = await deps.repo.findProfileByUserId(principal.user.id);
      if (!profile) throw new HomingError("not_found", "Object not found.", 404);
      return context.json(profileJson(profile));
    }),
  );

  router.patch(
    "/me/profile",
    withErrors(async (context) => {
      const principal = await requireSession(context, deps, true);
      const body = await parseJson(context);
      const patch: Partial<Omit<AuthProfile, "userId">> = {};
      if (body.display_name !== undefined) {
        const value = String(body.display_name).trim();
        if (!value || value.length > 120) {
          throw new HomingError("validation_error", "display_name is invalid.", 422);
        }
        patch.displayName = value;
      }
      if (body.timezone !== undefined) {
        const value = String(body.timezone).trim();
        try {
          if (!value || value.length > 64) throw new RangeError("invalid timezone");
          new Intl.DateTimeFormat("en", { timeZone: value }).format();
        } catch {
          throw new HomingError("validation_error", "timezone is invalid.", 422);
        }
        patch.timezone = value;
      }
      if (body.bio !== undefined) {
        const value = String(body.bio);
        if (value.length > 5000) {
          throw new HomingError("validation_error", "bio is too long.", 422);
        }
        patch.bio = value;
      }
      if (body.details !== undefined) {
        if (
          body.details === null ||
          typeof body.details !== "object" ||
          Array.isArray(body.details)
        ) {
          throw new HomingError("validation_error", "details must be an object.", 422);
        }
        if (!isBoundedJson(body.details)) {
          throw new HomingError("validation_error", "details is too large or deeply nested.", 422);
        }
        patch.personalDetails = body.details as Record<string, unknown>;
      }
      if (body.agent_paused_until !== undefined) {
        if (body.agent_paused_until === null || body.agent_paused_until === "") {
          patch.agentPausedUntil = null;
        } else {
          const value = new Date(String(body.agent_paused_until));
          if (Number.isNaN(value.getTime())) {
            throw new HomingError("validation_error", "agent_paused_until is invalid.", 422);
          }
          patch.agentPausedUntil = value;
        }
      }
      const profile = await deps.repo.updateProfile(principal.user.id, patch, nowOf(deps));
      if (!profile) throw new HomingError("not_found", "Object not found.", 404);
      return context.json(profileJson(profile));
    }),
  );

  router.get(
    "/me/token",
    withErrors(async (context) => {
      const principal = await resolvePrincipal(context, deps);
      const profile = await deps.repo.findProfileByUserId(principal.user.id);
      return context.json({
        id: principal.token?.id ?? null,
        name: principal.token?.name ?? "",
        scopes: principal.token?.scopes ?? AGENT_SCOPES,
        expires_at: iso(principal.token?.expiresAt),
        last_used_at: iso(principal.token?.lastUsedAt),
        agent_paused_until: iso(profile?.agentPausedUntil),
      });
    }),
  );

  router.get(
    "/auth/tokens",
    withErrors(async (context) => {
      const principal = await requireSession(context, deps);
      const items = await deps.repo.listTokens(principal.user.id);
      return context.json({ items: items.map(tokenMetadata) });
    }),
  );

  router.post(
    "/auth/tokens",
    withErrors(async (context) => {
      const principal = await requireSession(context, deps, true);
      const body = await parseJson(context);
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 120) {
        throw new HomingError(
          "validation_error",
          "name must be between 1 and 120 characters.",
          422,
        );
      }
      const scopes = checkedScopes(body.scopes);
      const expiresAt =
        body.expires_at === undefined ? undefined : new Date(String(body.expires_at));
      if (expiresAt && Number.isNaN(expiresAt.getTime())) {
        throw new HomingError("validation_error", "expires_at must be an ISO date.", 422);
      }
      const tokenInput = {
        name,
        scopes,
        projectIds: projectIds(body.project_ids),
        expectedCadenceMinutes: cadence(body.expected_cadence_minutes),
        environmentNote: String(body.environment_note ?? "").trim(),
        exposedToChat: body.exposed_to_chat === true,
        ...(expiresAt ? { expiresAt } : {}),
      };
      const created = await issueToken(deps, principal.user.id, tokenInput);
      return context.json(
        {
          id: created.token.id,
          token: created.raw,
          scopes: created.token.scopes,
          project_ids: created.token.projectIds,
          expires_at: created.token.expiresAt.toISOString(),
        },
        201,
      );
    }),
  );

  router.delete(
    "/auth/tokens/:id",
    withErrors(async (context) => {
      const principal = await requireSession(context, deps, true);
      const id = context.req.param("id");
      if (!id || !UUID_PATTERN.test(id)) {
        throw new HomingError("not_found", "Object not found.", 404);
      }
      const revoked = await deps.repo.revokeToken(principal.user.id, id, nowOf(deps));
      if (!revoked) throw new HomingError("not_found", "Object not found.", 404);
      return new Response(null, { status: 204 });
    }),
  );

  router.post(
    "/agent-link",
    withErrors(async (context) => {
      const address = clientAddress(context, deps);
      await consumeThrottle(deps, [["pairing-ip", address]], 10, 15 * 60_000);
      const body = await parseJson(context);
      const agentLabel = String(body.agent_label ?? "").trim();
      if (!agentLabel || agentLabel.length > 120) {
        throw new HomingError("validation_error", "agent_label is required.", 422);
      }
      const environmentNote = String(body.environment_note ?? "").trim();
      if (environmentNote.length > 200) {
        throw new HomingError("validation_error", "environment_note is too long.", 422);
      }
      const now = nowOf(deps);
      const deviceCode = randomOpaque();
      const baseInput = {
        deviceCodeDigest: digestOpaque(deviceCode),
        agentLabel,
        environmentNote,
        requestedCadenceMinutes: cadence(body.requested_cadence_minutes),
        expiresAt: new Date(now.getTime() + DEVICE_LINK_TTL_SECONDS * 1000),
        intervalSeconds: DEVICE_LINK_INTERVAL_SECONDS,
      };
      let link: AgentLinkRecord | null = null;
      for (let attempt = 0; attempt < 8 && !link; attempt += 1) {
        const input: CreateAgentLinkInput = { ...baseInput, userCode: newUserCode() };
        link = await deps.repo.createAgentLink(input);
      }
      if (!link) {
        throw new HomingError("conflict", "Could not allocate a pairing code. Try again.", 409);
      }
      const verificationUri = `${deps.origin}/link/`;
      return context.json(
        {
          device_code: deviceCode,
          user_code: link.userCode,
          verification_uri: verificationUri,
          verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(link.userCode)}`,
          expires_in: DEVICE_LINK_TTL_SECONDS,
          interval: link.intervalSeconds,
        },
        201,
      );
    }),
  );

  router.get(
    "/auth/agent-links/:code",
    withErrors(async (context) => {
      await requireSession(context, deps);
      const code = normalizeUserCode(context.req.param("code"));
      if (code.length !== 6) throw new HomingError("not_found", "Object not found.", 404);
      const link = await deps.repo.getPendingAgentLinkByCode(code, nowOf(deps));
      if (!link) throw new HomingError("not_found", "Object not found.", 404);
      return context.json({
        user_code: link.userCode,
        agent_label: link.agentLabel,
        environment_note: link.environmentNote,
        requested_cadence_minutes: link.requestedCadenceMinutes,
        expires_at: link.expiresAt.toISOString(),
      });
    }),
  );

  router.post(
    "/auth/agent-links/:code",
    withErrors(async (context) => {
      const principal = await requireSession(context, deps, true);
      const code = normalizeUserCode(context.req.param("code"));
      const body = await parseJson(context);
      const action = body.action;
      if (code.length !== 6 || (action !== "approve" && action !== "deny")) {
        throw new HomingError("validation_error", "A valid code and decision are required.", 422);
      }
      const decided = await deps.repo.decideAgentLink(
        code,
        principal.user.id,
        action === "approve" ? "approved" : "denied",
        nowOf(deps),
      );
      if (!decided) throw new HomingError("not_found", "Object not found.", 404);
      return context.json({ status: action === "approve" ? "approved" : "denied" });
    }),
  );

  router.post(
    "/agent-link/token",
    withErrors(async (context) => {
      const body = await parseJson(context);
      const deviceCode = String(body.device_code ?? "");
      if (!deviceCode || deviceCode.length > 256) {
        throw linkError("access_denied", "This pairing was not approved.");
      }
      const now = nowOf(deps);
      const poll = await deps.repo.pollAgentLink(
        digestOpaque(deviceCode),
        now,
        DEVICE_LINK_MAX_POLLS,
      );
      const link = poll.link;
      if (poll.outcome === "access_denied" || !link) {
        throw linkError("access_denied", "This pairing was not approved.");
      }
      if (poll.outcome === "slow_down") {
        throw linkError(
          "slow_down",
          `Poll no more than once every ${link.intervalSeconds} seconds.`,
          link.intervalSeconds,
        );
      }
      if (poll.outcome === "expired_token")
        throw linkError("expired_token", "This pairing request expired.");
      if (poll.outcome === "authorization_pending") {
        throw linkError(
          "authorization_pending",
          "Waiting for approval in Homing.",
          link.intervalSeconds,
        );
      }
      if (poll.outcome !== "approved" || link.approvedById === null) {
        throw linkError("access_denied", "This pairing was not approved.");
      }
      const user = await deps.repo.findUserById(link.approvedById);
      if (!user?.isActive) throw linkError("access_denied", "This pairing was not approved.");
      const generated = await tokenValue(deps, user.id, {
        name: link.agentLabel || "paired agent",
        scopes: [...PAIRED_AGENT_SCOPES],
        environmentNote: link.environmentNote,
        expectedCadenceMinutes: link.requestedCadenceMinutes,
        paired: true,
      });
      const issued = await deps.repo.consumeApprovedAgentLink(link.id, user.id, generated.input);
      if (!issued) throw linkError("access_denied", "This pairing was already used.");
      return context.json({
        token: generated.raw,
        expires_at: issued.expiresAt.toISOString(),
        scopes: issued.scopes,
      });
    }),
  );

  return router;
}

export type AuthRouter = ReturnType<typeof createAuthRouter>;
