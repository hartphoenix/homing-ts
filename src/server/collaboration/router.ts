import { createHash, randomBytes } from "node:crypto";

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import { errorResponse, HomingError } from "../http";
import { isBoundedJson } from "../json-limits";
import type {
  CollaborationDependencies,
  CollaborationPrincipal,
  CollaborationRepository,
  CommentRecord,
  InvitationRecord,
  LeadListOptions,
  LeadRecord,
  LeadWrite,
  MembershipRecord,
  ProjectRecord,
} from "./types";

const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Expected a UUID",
  );
const boundedRecord = z
  .record(z.string(), z.unknown())
  .refine((value) => isBoundedJson(value), "JSON is too large or deeply nested");
const criteria = boundedRecord.default({});
const role = z.enum(["owner", "editor", "viewer"]);
const housingType = z.enum(["entire", "shared", "unknown"]);
const dateConfidence = z.enum(["strong", "verify", "unknown"]);
const httpUrl = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Expected an HTTP(S) URL");

const projectCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).optional(),
    prompt: z.string().max(30_000),
    criteria,
  })
  .strict();
const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(220)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    description: z.string().max(20_000).optional(),
    status: z.enum(["active", "trashed"]).optional(),
  })
  .strict();
const promptSchema = z
  .object({
    prompt: z.string().max(30_000),
    criteria,
    expected_revision: z.number().int().min(0).max(2_147_483_647),
  })
  .strict();
const invitationRole = z.enum(["editor", "viewer"]);
const memberSchema = z
  .object({ email: z.string().trim().email().max(254), role: invitationRole.default("viewer") })
  .strict();
const memberPatchSchema = z.object({ role }).strict();
const memberActionSchema = z
  .object({ user_id: z.number().int().positive(), role: role.optional() })
  .strict();
const leadWriteSchema = z
  .object({
    id: uuid.optional(),
    source: z.string().trim().min(1).max(120),
    source_listing_id: z.string().max(300).optional(),
    url: httpUrl,
    identity_hash: z.string().max(64).optional(),
    source_url: httpUrl.optional(),
    title: z.string().trim().min(1).max(500),
    summary: z.string().max(30_000).optional(),
    location: z.string().max(500).optional(),
    price_display: z.string().max(200).optional(),
    price_amount: z
      .number()
      .finite()
      .nonnegative()
      .optional()
      .transform((value) => (value !== undefined && value <= 99_999_999.99 ? value : undefined)),
    currency: z
      .string()
      .max(3)
      .optional()
      .transform((value) => (value && /^[A-Za-z]{3}$/.test(value) ? value : undefined)),
    availability: z.string().max(200).optional(),
    housing_type: z
      .string()
      .max(100)
      .optional()
      .transform((value) => (housingType.safeParse(value).success ? value : undefined))
      .pipe(housingType.optional()),
    date_confidence: dateConfidence.optional(),
    listed_at: z.iso.date().nullable().optional(),
    parks: z.string().max(1_000).optional(),
    attributes: boundedRecord.optional(),
    verification_notes: z.string().max(10_000).optional(),
    observed_at: z.string().datetime({ local: true }).optional(),
    search_run_id: uuid.optional(),
    if_match: z.string().max(200).optional(),
  })
  .strict();
const leadPatchSchema = leadWriteSchema
  .partial()
  .extend({ expected_revision: z.number().int().positive().optional() })
  .strict();
const bulkSchema = z.object({ items: z.array(z.unknown()).min(1).max(100) }).strict();
const batchOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), item: leadWriteSchema }),
  z.object({ operation: z.literal("upsert"), item: leadWriteSchema }),
  z.object({
    operation: z.literal("trash"),
    lead_id: uuid,
    if_match: z.string().max(200).optional(),
  }),
  z.object({
    operation: z.literal("restore"),
    lead_id: uuid,
    if_match: z.string().max(200).optional(),
  }),
]);
const batchSchema = z
  .object({ operations: z.array(batchOperationSchema).min(1).max(100) })
  .strict();
const legacyBatchSchema = z
  .object({
    lead_ids: z.array(uuid).min(1).max(100),
    action: z.enum(["trash", "restore", "interested", "uninterested"]),
    comment: z.string().max(10_000).optional(),
  })
  .strict();
const interestSchema = z.object({ interested: z.boolean() }).strict();
const commentSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    parent_id: z.number().int().positive().optional(),
  })
  .strict();
const commentPatchSchema = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();

type Router = Hono;
type RequestContext = import("hono").Context;

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HomingError("validation_error", "The request body is invalid.", 422, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

async function readJson(context: RequestContext): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new HomingError("validation_error", "The request body must be valid JSON.", 422);
  }
}

function parseUuid(value: string, label: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new HomingError("validation_error", `${label} must be a UUID.`, 422);
  return parsed.data;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new HomingError("validation_error", `${label} is invalid.`, 422);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new HomingError("validation_error", `${label} is invalid.`, 422);
  return number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeListingUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || lower === "fbclid") url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function etag(prefix: string, value: unknown): string {
  return `"${prefix}-${digest(stableJson(value)).slice(0, 32)}"`;
}

function projectWire(
  project: ProjectRecord,
  membership?: MembershipRecord | null,
  includePrompt = false,
): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    status: project.status,
    role: membership?.role ?? null,
    creator_id: project.creatorId,
    prompt_revision: project.promptRevision,
    criteria: project.criteria,
    ...(includePrompt
      ? { prompt: project.currentPrompt, current_prompt: project.currentPrompt }
      : {}),
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}

function leadWire(
  lead: LeadRecord,
  stats?: {
    interested: boolean;
    interestCount: number;
    interestedUsers: string[];
    commentCount: number;
  },
): Record<string, unknown> {
  return {
    id: lead.id,
    project_id: lead.projectId,
    source: lead.source,
    source_listing_id: lead.sourceListingId,
    url: lead.canonicalUrl,
    canonical_url: lead.canonicalUrl,
    identity_hash: lead.identityHash,
    source_url: lead.sourceUrl,
    title: lead.title,
    summary: lead.summary,
    location: lead.location,
    price_display: lead.priceDisplay,
    price_amount: lead.priceAmount,
    currency: lead.priceCurrency,
    price_currency: lead.priceCurrency,
    availability: lead.availability,
    housing_type: lead.housingType,
    date_confidence: lead.dateConfidence,
    listed_at: lead.listedAt,
    parks: lead.parkNotes,
    park_notes: lead.parkNotes,
    attributes: lead.attributes,
    verification_notes: lead.verificationNotes,
    status: lead.status,
    trashed_at: lead.trashedAt?.toISOString() ?? null,
    interested: stats?.interested ?? false,
    is_interested: stats?.interested ?? false,
    interest_count: stats?.interestCount ?? 0,
    interested_users: stats?.interestedUsers ?? [],
    comment_count: stats?.commentCount ?? 0,
    creator_id: lead.creatorId,
    revision: lead.revision,
    created_at: lead.createdAt.toISOString(),
    updated_at: lead.updatedAt.toISOString(),
  };
}

function memberWire(member: MembershipRecord): Record<string, unknown> {
  return {
    user_id: member.userId,
    email: member.email ?? null,
    display_name: member.displayName ?? null,
    role: member.role,
    joined_at: member.joinedAt.toISOString(),
  };
}

function commentWire(comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.id,
    lead_id: comment.leadId,
    author_id: comment.authorId,
    parent_id: comment.parentId,
    body: comment.body,
    created_at: comment.createdAt.toISOString(),
    edited_at: comment.editedAt?.toISOString() ?? null,
  };
}

function invitationWire(invitation: InvitationRecord, token?: string): Record<string, unknown> {
  return {
    id: invitation.id,
    project_id: invitation.projectId,
    email: invitation.email,
    role: invitation.role,
    expires_at: invitation.expiresAt.toISOString(),
    created_at: invitation.createdAt.toISOString(),
    ...(token ? { token } : {}),
  };
}

async function getPrincipal(
  context: RequestContext,
  dependencies: CollaborationDependencies,
): Promise<CollaborationPrincipal> {
  const principal =
    (await dependencies.principal?.(context)) ??
    (context.get("principal") as CollaborationPrincipal | undefined);
  if (!principal || !Number.isSafeInteger(principal.userId) || principal.userId < 1)
    throw new HomingError("authentication_required", "Authentication is required.", 401);
  return principal;
}

function requireSession(principal: CollaborationPrincipal): void {
  if (principal.authKind === "bearer") {
    throw new HomingError("forbidden", "A browser session is required.", 403);
  }
}

function requireScope(principal: CollaborationPrincipal, scope: string): void {
  if (principal.authKind === "bearer" && !principal.scopes?.includes(scope)) {
    throw new HomingError("forbidden", "The credential does not permit this operation.", 403);
  }
}

function actor(context: RequestContext, principal: CollaborationPrincipal) {
  return {
    userId: principal.userId,
    tokenId: principal.tokenId ?? null,
    actorKind: principal.authKind === "bearer" ? ("agent" as const) : ("user" as const),
    requestId: String(context.get("requestId") ?? ""),
  };
}

async function json(
  context: RequestContext,
  status: ContentfulStatusCode,
  body: unknown,
  headers: Record<string, string> = {},
) {
  for (const [key, value] of Object.entries(headers)) context.header(key, value);
  return context.json(body, status);
}

function bodyHash(value: unknown): string {
  return digest(stableJson(value));
}

async function idempotent<T>(
  repository: CollaborationRepository,
  principal: CollaborationPrincipal,
  endpoint: string,
  key: string | undefined,
  body: unknown,
  run: (repository: CollaborationRepository) => Promise<{ status: ContentfulStatusCode; body: T }>,
): Promise<{ status: ContentfulStatusCode; body: T }> {
  if (!key) return run(repository);
  if (key.length > 200)
    throw new HomingError("validation_error", "Idempotency key is too long.", 422);
  return repository.transaction(async (transaction) => {
    await transaction.lockIdempotency(principal.userId, principal.tokenId ?? null, endpoint, key);
    const existing = await transaction.getIdempotency(
      principal.userId,
      principal.tokenId ?? null,
      endpoint,
      key,
    );
    const requestHash = bodyHash(body);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new HomingError(
          "idempotency_key_reused",
          "The idempotency key was used with different request data.",
          409,
        );
      return {
        status: existing.responseStatus as ContentfulStatusCode,
        body: existing.responseBody as T,
      };
    }
    const result = await run(transaction);
    await transaction.putIdempotency({
      userId: principal.userId,
      tokenId: principal.tokenId ?? null,
      endpoint,
      key,
      requestHash,
      responseStatus: result.status,
      responseBody: result.body,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    return result;
  });
}

async function requireProject(
  repository: CollaborationRepository,
  principal: CollaborationPrincipal,
  projectId: string,
  options: { owner?: boolean; scope?: string; allowTrashed?: boolean } = {},
): Promise<{ project: ProjectRecord; membership: MembershipRecord }> {
  parseUuid(projectId, "project");
  const project = await repository.getProject(projectId);
  const membership = await repository.getMembership(projectId, principal.userId);
  if (
    !project ||
    (!options.allowTrashed && project.status !== "active") ||
    !membership ||
    (principal.projectIds &&
      principal.projectIds.length > 0 &&
      !principal.projectIds.includes(projectId))
  ) {
    throw new HomingError("not_found", "Object not found.", 404);
  }
  if (options.scope) requireScope(principal, options.scope);
  if (options.owner && membership.role !== "owner")
    throw new HomingError("forbidden", "Owner permission is required.", 403);
  return { project, membership };
}

function checkIfMatch(context: RequestContext, current: string): void {
  const supplied = context.req.header("If-Match");
  if (supplied && supplied !== current && supplied !== "*")
    throw new HomingError("stale_write", "The object changed since it was read.", 409, {
      etag: current,
    });
}

function leadEtag(lead: LeadRecord): string {
  return `"${lead.revision}"`;
}

function requiredLeadRevision(context: RequestContext, lead: LeadRecord): number {
  const supplied = context.req.header("If-Match");
  if (!supplied)
    throw new HomingError("if_match_required", "If-Match is required for lead writes.", 409);
  if (supplied.replace(/^W\//, "").replaceAll('"', "") !== String(lead.revision)) {
    throw new HomingError("stale_write", "The lead changed since it was read.", 409, {
      current_revision: lead.revision,
    });
  }
  return lead.revision;
}

function convertLeadWrite(value: z.infer<typeof leadWriteSchema>): LeadWrite {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as LeadWrite;
}

function pathId(context: RequestContext, name: string): string {
  return parseUuid(context.req.param(name) ?? "", name);
}

function makeInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generatedSlug(name: string, id: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 200) || "project";
  return `${base}-${id.slice(0, 8)}`;
}

function newProjectId(makeId: () => string): string {
  return parseUuid(makeId(), "project");
}

export function createCollaborationRouter(dependencies: CollaborationDependencies): Router {
  const app = new Hono();
  const repository = dependencies.repository;
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.makeId ?? (() => crypto.randomUUID());

  app.onError((error, context) => {
    if (error instanceof HomingError)
      return errorResponse(context as unknown as Parameters<typeof errorResponse>[0], error);
    const databaseError =
      error instanceof Error && error.cause && typeof error.cause === "object"
        ? (error.cause as { code?: unknown; constraint?: unknown })
        : undefined;
    console.error(
      JSON.stringify({
        level: "error",
        event: "collaboration_request_failed",
        error: error.name,
        ...(typeof databaseError?.code === "string" ? { database_code: databaseError.code } : {}),
        ...(typeof databaseError?.constraint === "string"
          ? { database_constraint: databaseError.constraint }
          : {}),
      }),
    );
    return errorResponse(
      context as unknown as Parameters<typeof errorResponse>[0],
      new HomingError("server_error", "The request could not be completed.", 500),
    );
  });

  app.get("/me/projects", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireScope(principal, "projects:read");
    const projects = (await repository.listProjects(principal.userId)).filter(
      (project) => !principal.projectIds?.length || principal.projectIds.includes(project.id),
    );
    const items = await Promise.all(
      projects.map(async (project) =>
        projectWire(project, await repository.getMembership(project.id, principal.userId)),
      ),
    );
    const pausedUntil = await repository.getAgentPausedUntil(principal.userId);
    return json(context, 200, {
      items,
      projects: items,
      agent_paused_until: pausedUntil?.toISOString() ?? null,
    });
  });

  app.post("/projects", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const body = parseBody(projectCreateSchema, await readJson(context));
    const projectId = newProjectId(makeId);
    const timestamp = now();
    const project: Omit<ProjectRecord, "createdAt" | "updatedAt"> = {
      id: projectId,
      name: body.name,
      slug: generatedSlug(body.name, projectId),
      description: body.description ?? "",
      currentPrompt: body.prompt,
      criteria: body.criteria,
      status: "active",
      creatorId: principal.userId,
      promptRevision: 0,
    };
    const result = await repository.transaction(async (transaction) => {
      const created = await transaction.createProject(project);
      await transaction.upsertMembership({
        projectId,
        userId: principal.userId,
        role: "owner",
        joinedAt: timestamp,
      });
      await transaction.updatePrompt(
        projectId,
        0,
        created.currentPrompt,
        created.criteria,
        principal.userId,
      );
      await transaction.recordMutation(
        projectId,
        "project.created",
        "project",
        projectId,
        { revision: 1 },
        actor(context, principal),
      );
      return transaction.getProject(projectId);
    });
    if (!result) throw new HomingError("server_error", "The project could not be created.", 500);
    return json(
      context,
      201,
      projectWire(result, await repository.getMembership(projectId, principal.userId), true),
      { ETag: etag("project", result) },
    );
  });

  app.get("/projects/:projectId", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    const projectId = pathId(context, "projectId");
    const { project, membership } = await requireProject(repository, principal, projectId, {
      scope: "projects:read",
    });
    const output = projectWire(project, membership, true);
    return json(context, 200, output, { ETag: etag("project", project) });
  });

  app.patch("/projects/:projectId", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    const { project, membership } = await requireProject(repository, principal, projectId);
    checkIfMatch(context, etag("project", project));
    const body = parseBody(projectPatchSchema, await readJson(context));
    if (body.status === "trashed") {
      if ((await repository.getMembership(projectId, principal.userId))?.role !== "owner")
        throw new HomingError("forbidden", "Owner permission is required.", 403);
    }
    const projectPatch: Partial<Pick<ProjectRecord, "name" | "slug" | "description" | "status">> =
      Object.fromEntries(Object.entries(body).filter(([, entry]) => entry !== undefined));
    const updated = await repository.transaction(async (transaction) => {
      if (body.status === "trashed") await transaction.assertOwner(projectId, principal.userId);
      await transaction.updateProject(projectId, projectPatch);
      await transaction.recordMutation(
        projectId,
        body.status === "trashed" ? "project.trashed" : "project.updated",
        "project",
        projectId,
        { fields: Object.keys(projectPatch).sort() },
        actor(context, principal),
        { tombstone: body.status === "trashed" },
      );
      const result = await transaction.getProject(projectId);
      if (!result) throw new HomingError("not_found", "Object not found.", 404);
      return result;
    });
    return json(context, 200, projectWire(updated, membership, true), {
      ETag: etag("project", updated),
    });
  });

  app.delete("/projects/:projectId", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    const { project, membership } = await requireProject(repository, principal, projectId, {
      owner: true,
    });
    checkIfMatch(context, etag("project", project));
    const updated = await repository.transaction(async (transaction) => {
      await transaction.assertOwner(projectId, principal.userId);
      await transaction.updateProject(projectId, { status: "trashed" });
      await transaction.recordMutation(
        projectId,
        "project.trashed",
        "project",
        projectId,
        { status: "trashed" },
        actor(context, principal),
        { tombstone: true },
      );
      const result = await transaction.getProject(projectId);
      if (!result) throw new HomingError("not_found", "Object not found.", 404);
      return result;
    });
    return json(context, 200, projectWire(updated, membership), { ETag: etag("project", updated) });
  });

  app.post("/projects/:projectId/restore", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    const { project, membership } = await requireProject(repository, principal, projectId, {
      owner: true,
      allowTrashed: true,
    });
    checkIfMatch(context, etag("project", project));
    const updated = await repository.transaction(async (transaction) => {
      await transaction.assertOwner(projectId, principal.userId);
      await transaction.updateProject(projectId, { status: "active" });
      await transaction.recordMutation(
        projectId,
        "project.restored",
        "project",
        projectId,
        { status: "active" },
        actor(context, principal),
      );
      const result = await transaction.getProject(projectId);
      if (!result) throw new HomingError("not_found", "Object not found.", 404);
      return result;
    });
    return json(context, 200, projectWire(updated, membership), { ETag: etag("project", updated) });
  });

  app.get("/projects/:projectId/prompt", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    const projectId = pathId(context, "projectId");
    const { project } = await requireProject(repository, principal, projectId, {
      scope: "prompts:read",
    });
    const prompt = await repository.getPrompt(projectId);
    if (!prompt) throw new HomingError("not_found", "Object not found.", 404);
    return json(
      context,
      200,
      {
        prompt: prompt.prompt,
        criteria: prompt.criteria,
        revision: project.promptRevision,
        prompt_revision: project.promptRevision,
        updated_at: prompt.createdAt.toISOString(),
      },
      { ETag: `"${project.promptRevision}"` },
    );
  });

  const listPromptRevisions = async (context: RequestContext) => {
    const principal = await getPrincipal(context, dependencies);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId, { scope: "prompts:read" });
    const revisions = await repository.listPromptRevisions(projectId);
    return json(context, 200, {
      items: revisions.map((revision) => ({
        id: revision.id,
        project_id: revision.projectId,
        revision: revision.revision,
        prompt: revision.prompt,
        criteria: revision.criteria,
        editor_id: revision.editorId,
        created_at: revision.createdAt.toISOString(),
        updated_at: revision.createdAt.toISOString(),
      })),
    });
  };
  app.get("/projects/:projectId/prompt/revisions", listPromptRevisions);
  app.get("/projects/:projectId/prompt-revisions", listPromptRevisions);

  const updatePrompt = async (context: RequestContext) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId);
    const body = parseBody(promptSchema, await readJson(context));
    const current = await repository.getPrompt(projectId);
    if (!current) throw new HomingError("not_found", "Object not found.", 404);
    const supplied = context.req.header("If-Match");
    if (
      supplied &&
      supplied !== "*" &&
      supplied.replace(/^W\//, "").replaceAll('"', "") !== String(current.revision)
    ) {
      throw new HomingError("stale_write", "The prompt changed since it was read.", 409, {
        current_revision: current.revision,
        draft: body,
      });
    }
    let result: Awaited<ReturnType<CollaborationRepository["updatePrompt"]>>;
    try {
      result = await repository.transaction(async (transaction) => {
        const updated = await transaction.updatePrompt(
          projectId,
          body.expected_revision,
          body.prompt,
          body.criteria,
          principal.userId,
        );
        await transaction.recordMutation(
          projectId,
          "prompt.updated",
          "project",
          projectId,
          { revision: updated.revision.revision },
          actor(context, principal),
        );
        return updated;
      });
    } catch (error) {
      if (error instanceof HomingError && error.code === "stale_write")
        throw new HomingError(error.code, error.message, error.status, {
          ...error.fields,
          draft: body,
        });
      throw error;
    }
    return json(
      context,
      200,
      {
        prompt: result.revision.prompt,
        criteria: result.revision.criteria,
        revision: result.revision.revision,
        prompt_revision: result.revision.revision,
        updated_at: result.revision.createdAt.toISOString(),
      },
      { ETag: `"${result.revision.revision}"` },
    );
  };
  app.patch("/projects/:projectId/prompt", updatePrompt);
  app.put("/projects/:projectId/prompt", updatePrompt);

  app.get("/projects/:projectId/members", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId);
    const members = await repository.listMemberships(projectId);
    return json(context, 200, { items: members.map(memberWire) });
  });

  app.post("/projects/:projectId/invitations", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId);
    const body = parseBody(memberSchema, await readJson(context));
    const token = makeInvitationToken();
    const invitation: InvitationRecord = {
      id: makeId(),
      projectId,
      email: normalizeEmail(body.email),
      role: body.role,
      inviterId: principal.userId,
      tokenDigest: digest(token),
      expiresAt: new Date(now().getTime() + 7 * 86_400_000),
      acceptedAt: null,
      revokedAt: null,
      createdAt: now(),
    };
    const created = await repository.transaction(async (transaction) => {
      const result = await transaction.createInvitation(invitation);
      await transaction.recordMutation(
        projectId,
        "invitation.created",
        "invitation",
        result.id,
        { role: result.role },
        actor(context, principal),
      );
      return result;
    });
    return json(context, 201, {
      ...invitationWire(created, token),
      invite_url: `/invitations/${token}/accept`,
    });
  });

  app.patch("/projects/:projectId/members", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId, { owner: true });
    const body = parseBody(memberActionSchema.extend({ role }), await readJson(context));
    const current = await repository.getMembership(projectId, body.user_id);
    if (!current) throw new HomingError("not_found", "Object not found.", 404);
    const updated = await repository.transaction(async (transaction) => {
      const result = await transaction.changeMembershipRole(
        projectId,
        body.user_id,
        body.role,
        principal.userId,
      );
      await transaction.recordMutation(
        projectId,
        "membership.role_changed",
        "membership",
        String(body.user_id),
        { user_id: String(body.user_id), role: body.role },
        actor(context, principal),
      );
      return result;
    });
    return json(context, 200, memberWire(updated));
  });

  app.delete("/projects/:projectId/members", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId, { owner: true });
    const body = parseBody(memberActionSchema.omit({ role: true }), await readJson(context));
    const target = await repository.getMembership(projectId, body.user_id);
    if (!target) throw new HomingError("not_found", "Object not found.", 404);
    await repository.transaction(async (transaction) => {
      await transaction.removeMembershipSafely(projectId, body.user_id, principal.userId);
      await transaction.recordMutation(
        projectId,
        "membership.removed",
        "membership",
        String(body.user_id),
        { user_id: String(body.user_id), role: target.role },
        actor(context, principal),
        { tombstone: true },
      );
    });
    return new Response(null, { status: 204 });
  });

  app.patch("/projects/:projectId/members/:userId", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId, { owner: true });
    const userId = parseInteger(
      context.req.param("userId"),
      0,
      1,
      Number.MAX_SAFE_INTEGER,
      "userId",
    );
    const body = parseBody(memberPatchSchema, await readJson(context));
    const current = await repository.getMembership(projectId, userId);
    if (!current) throw new HomingError("not_found", "Object not found.", 404);
    const updated = await repository.transaction(async (transaction) => {
      const result = await transaction.changeMembershipRole(
        projectId,
        userId,
        body.role,
        principal.userId,
      );
      await transaction.recordMutation(
        projectId,
        "membership.role_changed",
        "membership",
        String(userId),
        { user_id: String(userId), role: body.role },
        actor(context, principal),
      );
      return result;
    });
    return json(context, 200, memberWire(updated));
  });

  app.delete("/projects/:projectId/members/:userId", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId, { owner: true });
    const userId = parseInteger(
      context.req.param("userId"),
      0,
      1,
      Number.MAX_SAFE_INTEGER,
      "userId",
    );
    const target = await repository.getMembership(projectId, userId);
    if (!target) throw new HomingError("not_found", "Object not found.", 404);
    await repository.transaction(async (transaction) => {
      await transaction.removeMembershipSafely(projectId, userId, principal.userId);
      await transaction.recordMutation(
        projectId,
        "membership.removed",
        "membership",
        String(userId),
        { user_id: String(userId), role: target.role },
        actor(context, principal),
        { tombstone: true },
      );
    });
    return new Response(null, { status: 204 });
  });

  app.post("/invitations/:token/accept", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    requireSession(principal);
    const token = context.req.param("token");
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token))
      throw new HomingError("not_found", "Object not found.", 404);
    const invitation = await repository.getInvitationByTokenDigest(digest(token));
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= now()
    )
      throw new HomingError("not_found", "Object not found.", 404);
    if (
      !principal.email ||
      normalizeEmail(principal.email) !== invitation.email ||
      !(await repository.isUserActive(invitation.inviterId)) ||
      !(await repository.getMembership(invitation.projectId, invitation.inviterId))
    )
      throw new HomingError("not_found", "Object not found.", 404);
    const membership = await repository.transaction(async (transaction) => {
      const existing = await transaction.getMembership(invitation.projectId, principal.userId);
      const joined =
        existing ??
        (await transaction.upsertMembership({
          projectId: invitation.projectId,
          userId: principal.userId,
          role: invitation.role,
          joinedAt: now(),
        }));
      await transaction.updateInvitation(invitation.id, { acceptedAt: now() });
      await transaction.recordMutation(
        invitation.projectId,
        "invitation.accepted",
        "invitation",
        invitation.id,
        { user_id: String(principal.userId) },
        actor(context, principal),
      );
      return joined;
    });
    return json(context, 200, memberWire(membership));
  });

  async function leadAccess(context: RequestContext, scope: string) {
    const principal = await getPrincipal(context, dependencies);
    const projectId = pathId(context, "projectId");
    const access = await requireProject(repository, principal, projectId, { scope });
    return { principal, projectId, project: access.project };
  }

  async function wireLead(projectId: string, lead: LeadRecord, userId: number) {
    return leadWire(lead, await repository.getLeadStats(projectId, lead.id, userId));
  }

  async function listLeadResponse(
    context: RequestContext,
    forcedStatus?: "active" | "trashed",
    forcedInterest?: "me",
  ) {
    const { principal, projectId } = await leadAccess(
      context,
      forcedInterest ? "interest:read" : "leads:read",
    );
    const statusValue =
      forcedStatus ??
      (context.req.query("status") === "trashed" || context.req.query("status") === "trash"
        ? "trashed"
        : "active");
    const limit = parseInteger(
      context.req.query("limit"),
      forcedStatus === "trashed" ? 100 : 50,
      1,
      100,
      "limit",
    );
    const after = context.req.query("cursor");
    const query = context.req.query("q")?.slice(0, 200);
    const requestedSort = context.req.query("sort") ?? "updated";
    if (
      ![
        "updated",
        "newest",
        "oldest",
        "interest",
        "price_asc",
        "price_desc",
        "source_asc",
        "source_desc",
        "days_asc",
        "days_desc",
      ].includes(requestedSort)
    )
      throw new HomingError("validation_error", "sort is invalid.", 422);
    const interestScope =
      forcedInterest ??
      context.req.query("interest_scope") ??
      (context.req.query("interested_by") === "me" ? "me" : "all");
    if (!["all", "me", "anyone", "any"].includes(interestScope))
      throw new HomingError("validation_error", "interest_scope is invalid.", 422);
    const result = await repository.listLeads(projectId, {
      status: statusValue,
      limit,
      ...(after ? { after } : {}),
      ...(query ? { query } : {}),
      ...(interestScope === "me" ? { interestedUserId: principal.userId } : {}),
      ...(interestScope === "any" || interestScope === "anyone"
        ? { interestedByAnyone: true }
        : {}),
      sort: requestedSort as NonNullable<LeadListOptions["sort"]>,
    });
    const items = await Promise.all(
      result.items.map((lead) => wireLead(projectId, lead, principal.userId)),
    );
    return json(context, 200, {
      items,
      total: result.total,
      next_cursor: result.next ?? null,
    });
  }

  app.get("/projects/:projectId/leads/interested", async (context) => {
    return listLeadResponse(context, "active", "me");
  });

  app.get("/projects/:projectId/leads/trash", async (context) => {
    return listLeadResponse(context, "trashed");
  });
  app.get("/projects/:projectId/trash", (context) => listLeadResponse(context, "trashed"));
  app.get("/projects/:projectId/interested", (context) =>
    listLeadResponse(context, "active", "me"),
  );

  app.get("/projects/:projectId/leads", async (context) => {
    return listLeadResponse(context);
  });

  app.post("/projects/:projectId/leads", async (context) => {
    const { principal, projectId } = await leadAccess(context, "leads:write");
    const body = parseBody(leadWriteSchema, await readJson(context));
    const result = await idempotent(
      repository,
      principal,
      context.req.path,
      context.req.header("Idempotency-Key"),
      body,
      async (transaction) => {
        const [written] = await transaction.bulkUpsertLeads(projectId, principal.userId, [
          convertLeadWrite(body),
        ]);
        if (!written?.lead || written.outcome === "error" || written.outcome === "conflict")
          throw new HomingError(
            written?.error?.code ?? "identity_conflict",
            written?.error?.message ?? "The lead could not be saved.",
            409,
          );
        await transaction.recordMutation(
          projectId,
          `lead.${written.outcome}`,
          "lead",
          written.lead.id,
          { revision: written.lead.revision },
          actor(context, principal),
        );
        return { status: written.outcome === "created" ? 201 : 200, body: leadWire(written.lead) };
      },
    );
    return json(context, result.status, result.body, {
      ETag: `"${String((result.body as Record<string, unknown>).revision)}"`,
    });
  });

  app.post("/projects/:projectId/leads/bulk-upsert", async (context) => {
    const { principal, projectId } = await leadAccess(context, "leads:write");
    const body = parseBody(bulkSchema, await readJson(context));
    const result = await idempotent(
      repository,
      principal,
      context.req.path,
      context.req.header("Idempotency-Key"),
      body,
      async (transaction) => {
        const results: Array<Record<string, unknown>> = [];
        for (const [index, raw] of body.items.entries()) {
          const parsed = leadWriteSchema.safeParse(raw);
          if (!parsed.success) {
            results.push({
              index,
              outcome: "error",
              error: { code: "validation_error", message: "The lead is invalid." },
            });
            continue;
          }
          const [item] = await transaction.bulkUpsertLeads(projectId, principal.userId, [
            convertLeadWrite(parsed.data),
          ]);
          if (!item) {
            results.push({
              index,
              outcome: "error",
              error: { code: "server_error", message: "The lead could not be saved." },
            });
            continue;
          }
          if (item.lead && (item.outcome === "created" || item.outcome === "updated")) {
            await transaction.recordMutation(
              projectId,
              `lead.${item.outcome}`,
              "lead",
              item.lead.id,
              { revision: item.lead.revision },
              actor(context, principal),
            );
          }
          results.push({
            index,
            outcome: item.outcome,
            ...(item.lead ? { lead: leadWire(item.lead) } : {}),
            ...(item.error ? { error: item.error } : {}),
          });
        }
        return { status: 200, body: { results } };
      },
    );
    return json(context, result.status, result.body);
  });

  app.post("/projects/:projectId/leads/batch", async (context) => {
    const { principal, projectId } = await leadAccess(context, "leads:write");
    const raw = await readJson(context);
    const modern = batchSchema.safeParse(raw);
    const legacy = legacyBatchSchema.safeParse(raw);
    let body: z.infer<typeof batchSchema> | z.infer<typeof legacyBatchSchema>;
    if (modern.success) body = modern.data;
    else if (legacy.success) body = legacy.data;
    else throw new HomingError("validation_error", "The request body is invalid.", 422);
    const destructive =
      "action" in body
        ? body.action === "trash" || body.action === "restore"
        : body.operations.some(
            (operation) => operation.operation === "trash" || operation.operation === "restore",
          );
    if (destructive) requireScope(principal, "leads:destroy");
    const result = await idempotent<Record<string, unknown>>(
      repository,
      principal,
      context.req.path,
      context.req.header("Idempotency-Key"),
      body,
      async (transaction) => {
        const outputs: Array<Record<string, unknown>> = [];
        if ("action" in body) {
          const selected = await Promise.all(
            body.lead_ids.map((leadId) => transaction.getLead(projectId, leadId)),
          );
          if (selected.some((lead) => !lead))
            throw new HomingError(
              "validation_error",
              "Every lead must belong to this project.",
              422,
            );
          for (const lead of selected as LeadRecord[]) {
            if (body.action === "interested" || body.action === "uninterested") {
              const interested = body.action === "interested";
              await transaction.setInterest(projectId, lead.id, principal.userId, interested);
              await transaction.recordMutation(
                projectId,
                "interest.set",
                "lead",
                lead.id,
                { user_id: String(principal.userId), interested },
                actor(context, principal),
              );
              outputs.push({ action: body.action, ...leadWire(lead) });
            } else {
              const status = body.action === "trash" ? "trashed" : "active";
              const updated = await transaction.setLeadStatus(
                projectId,
                lead.id,
                status,
                principal.userId,
                lead.revision,
              );
              await transaction.recordMutation(
                projectId,
                `lead.${body.action === "trash" ? "trashed" : "restored"}`,
                "lead",
                lead.id,
                { revision: updated.revision },
                actor(context, principal),
                { tombstone: body.action === "trash" },
              );
              outputs.push({ action: body.action, ...leadWire(updated) });
            }
          }
          return { status: 200, body: { action: body.action, items: outputs } };
        }
        for (const operation of body.operations) {
          if (operation.operation === "create" || operation.operation === "upsert") {
            const [written] = await transaction.bulkUpsertLeads(projectId, principal.userId, [
              convertLeadWrite(operation.item),
            ]);
            if (!written || written.outcome === "error" || written.outcome === "conflict")
              throw new HomingError(
                written?.error?.code ?? "conflict",
                written?.error?.message ?? "Batch operation failed.",
                409,
              );
            if (written.lead && (written.outcome === "created" || written.outcome === "updated"))
              await transaction.recordMutation(
                projectId,
                `lead.${written.outcome}`,
                "lead",
                written.lead.id,
                { revision: written.lead.revision },
                actor(context, principal),
              );
            outputs.push({
              operation: operation.operation,
              outcome: written.outcome,
              lead: written.lead ? leadWire(written.lead) : null,
            });
          } else {
            const current = await transaction.getLead(projectId, operation.lead_id);
            if (!current) throw new HomingError("not_found", "Object not found.", 404);
            const currentTag = leadEtag(current);
            if (
              operation.if_match &&
              operation.if_match !== currentTag &&
              operation.if_match !== "*"
            )
              throw new HomingError("stale_write", "The lead changed since it was read.", 409);
            const lead = await transaction.setLeadStatus(
              projectId,
              operation.lead_id,
              operation.operation === "trash" ? "trashed" : "active",
              principal.userId,
              current.revision,
            );
            await transaction.recordMutation(
              projectId,
              `lead.${operation.operation === "trash" ? "trashed" : "restored"}`,
              "lead",
              lead.id,
              { revision: lead.revision },
              actor(context, principal),
              { tombstone: operation.operation === "trash" },
            );
            outputs.push({
              operation: operation.operation,
              outcome: "updated",
              lead: leadWire(lead),
            });
          }
        }
        return { status: 200, body: { items: outputs } };
      },
    );
    return json(context, result.status, result.body);
  });

  app.get("/projects/:projectId/leads/:leadId", async (context) => {
    const { principal, projectId } = await leadAccess(context, "leads:read");
    const leadId = pathId(context, "leadId");
    const lead = await repository.getLead(projectId, leadId);
    if (!lead) throw new HomingError("not_found", "Object not found.", 404);
    return json(context, 200, await wireLead(projectId, lead, principal.userId), {
      ETag: leadEtag(lead),
    });
  });

  app.patch("/projects/:projectId/leads/:leadId", async (context) => {
    const { principal, projectId } = await leadAccess(context, "leads:write");
    const leadId = pathId(context, "leadId");
    const current = await repository.getLead(projectId, leadId);
    if (!current || current.status === "trashed")
      throw new HomingError("not_found", "Object not found.", 404);
    const body = parseBody(leadPatchSchema, await readJson(context));
    let expectedRevision: number;
    try {
      expectedRevision = requiredLeadRevision(context, current);
    } catch (error) {
      if (error instanceof HomingError)
        throw new HomingError(error.code, error.message, error.status, {
          ...error.fields,
          draft: body,
        });
      throw error;
    }
    if (body.expected_revision !== undefined && body.expected_revision !== current.revision)
      throw new HomingError("stale_write", "The lead changed since it was read.", 409, {
        current_revision: current.revision,
        draft: body,
      });
    const patch: Partial<LeadRecord> = {};
    if (body.url !== undefined) {
      patch.canonicalUrl = body.url;
      patch.identityHash = digest(normalizeListingUrl(body.url));
    }
    if (body.source_url !== undefined) patch.sourceUrl = body.source_url;
    if (body.title !== undefined) patch.title = body.title;
    if (body.summary !== undefined) patch.summary = body.summary;
    if (body.location !== undefined) patch.location = body.location;
    if (body.price_display !== undefined) patch.priceDisplay = body.price_display;
    if (body.price_amount !== undefined) patch.priceAmount = body.price_amount;
    if (body.listed_at !== undefined) patch.listedAt = body.listed_at;
    if (body.currency !== undefined) patch.priceCurrency = body.currency;
    if (body.availability !== undefined) patch.availability = body.availability;
    if (body.housing_type !== undefined) patch.housingType = body.housing_type;
    if (body.date_confidence !== undefined) patch.dateConfidence = body.date_confidence;
    if (body.parks !== undefined) patch.parkNotes = body.parks;
    if (body.attributes !== undefined) patch.attributes = body.attributes;
    if (body.verification_notes !== undefined) patch.verificationNotes = body.verification_notes;
    let updated: LeadRecord;
    try {
      updated = await repository.transaction(async (transaction) => {
        const result = await transaction.updateLead(projectId, leadId, expectedRevision, patch);
        await transaction.recordMutation(
          projectId,
          "lead.updated",
          "lead",
          leadId,
          { revision: result.revision },
          actor(context, principal),
        );
        return result;
      });
    } catch (error) {
      if (error instanceof HomingError && error.code === "stale_write")
        throw new HomingError(error.code, error.message, error.status, {
          ...error.fields,
          draft: body,
        });
      throw error;
    }
    return json(context, 200, await wireLead(projectId, updated, principal.userId), {
      ETag: leadEtag(updated),
    });
  });

  async function changeLeadStatus(context: RequestContext, status: "active" | "trashed") {
    const { principal, projectId } = await leadAccess(context, "leads:destroy");
    const leadId = pathId(context, "leadId");
    const current = await repository.getLead(projectId, leadId);
    if (!current) throw new HomingError("not_found", "Object not found.", 404);
    const supplied = context.req.header("If-Match");
    if (status === "active") requiredLeadRevision(context, current);
    else if (
      supplied &&
      supplied !== "*" &&
      supplied.replace(/^W\//, "").replaceAll('"', "") !== String(current.revision)
    )
      throw new HomingError("stale_write", "The lead changed since it was read.", 409);
    const updated = await repository.transaction(async (transaction) => {
      const result = await transaction.setLeadStatus(
        projectId,
        leadId,
        status,
        principal.userId,
        current.revision,
      );
      await transaction.recordMutation(
        projectId,
        status === "trashed" ? "lead.trashed" : "lead.restored",
        "lead",
        leadId,
        { revision: result.revision },
        actor(context, principal),
        { tombstone: status === "trashed" },
      );
      return result;
    });
    return json(context, 200, await wireLead(projectId, updated, principal.userId), {
      ETag: leadEtag(updated),
    });
  }
  app.delete("/projects/:projectId/leads/:leadId", (context) =>
    changeLeadStatus(context, "trashed"),
  );
  app.post("/projects/:projectId/leads/:leadId/restore", (context) =>
    changeLeadStatus(context, "active"),
  );
  app.post("/projects/:projectId/trash/:leadId/restore", (context) =>
    changeLeadStatus(context, "active"),
  );

  app.delete("/projects/:projectId/leads/:leadId/permanent", async (context) => {
    const principal = await getPrincipal(context, dependencies);
    const projectId = pathId(context, "projectId");
    await requireProject(repository, principal, projectId, { owner: true, scope: "leads:destroy" });
    const leadId = pathId(context, "leadId");
    const current = await repository.getLead(projectId, leadId);
    if (!current) throw new HomingError("not_found", "Object not found.", 404);
    requiredLeadRevision(context, current);
    await repository.transaction(async (transaction) => {
      await transaction.assertOwner(projectId, principal.userId);
      await transaction.permanentlyDeleteLead(projectId, leadId);
      await transaction.recordMutation(
        projectId,
        "lead.destroyed",
        "lead",
        leadId,
        {},
        actor(context, principal),
        { tombstone: true },
      );
    });
    return new Response(null, { status: 204 });
  });

  app.post("/projects/:projectId/leads/:leadId/interest", async (context) => {
    const { principal, projectId } = await leadAccess(context, "interest:write");
    const leadId = pathId(context, "leadId");
    const lead = await repository.getLead(projectId, leadId);
    if (!lead || lead.status === "trashed")
      throw new HomingError("not_found", "Object not found.", 404);
    const body = parseBody(interestSchema, await readJson(context));
    const interested = await repository.transaction(async (transaction) => {
      const before = await transaction.getInterest(projectId, leadId, principal.userId);
      const result = await transaction.setInterest(
        projectId,
        leadId,
        principal.userId,
        body.interested,
      );
      if (before !== result)
        await transaction.recordMutation(
          projectId,
          "interest.set",
          "lead",
          leadId,
          { user_id: String(principal.userId), interested: result },
          actor(context, principal),
        );
      return result;
    });
    return json(context, 200, { lead_id: leadId, interested });
  });
  app.put("/projects/:projectId/leads/:leadId/interest", async (context) => {
    const { principal, projectId } = await leadAccess(context, "interest:write");
    const leadId = pathId(context, "leadId");
    const lead = await repository.getLead(projectId, leadId);
    if (!lead || lead.status === "trashed")
      throw new HomingError("not_found", "Object not found.", 404);
    await repository.transaction(async (transaction) => {
      const before = await transaction.getInterest(projectId, leadId, principal.userId);
      await transaction.setInterest(projectId, leadId, principal.userId, true);
      if (!before)
        await transaction.recordMutation(
          projectId,
          "interest.set",
          "lead",
          leadId,
          { user_id: String(principal.userId), interested: true },
          actor(context, principal),
        );
    });
    return new Response(null, { status: 204 });
  });
  app.delete("/projects/:projectId/leads/:leadId/interest", async (context) => {
    const { principal, projectId } = await leadAccess(context, "interest:write");
    const leadId = pathId(context, "leadId");
    const lead = await repository.getLead(projectId, leadId);
    if (!lead || lead.status === "trashed")
      throw new HomingError("not_found", "Object not found.", 404);
    await repository.transaction(async (transaction) => {
      const before = await transaction.getInterest(projectId, leadId, principal.userId);
      await transaction.setInterest(projectId, leadId, principal.userId, false);
      if (before)
        await transaction.recordMutation(
          projectId,
          "interest.set",
          "lead",
          leadId,
          { user_id: String(principal.userId), interested: false },
          actor(context, principal),
        );
    });
    return new Response(null, { status: 204 });
  });

  app.get("/projects/:projectId/leads/:leadId/comments", async (context) => {
    const { projectId } = await leadAccess(context, "comments:read");
    const leadId = pathId(context, "leadId");
    const lead = await repository.getLead(projectId, leadId);
    if (!lead || lead.status === "trashed")
      throw new HomingError("not_found", "Object not found.", 404);
    const comments = await repository.listComments(projectId, leadId);
    return json(context, 200, { items: comments.map(commentWire) });
  });

  app.post("/projects/:projectId/leads/:leadId/comments", async (context) => {
    const { principal, projectId } = await leadAccess(context, "comments:write");
    const leadId = pathId(context, "leadId");
    const lead = await repository.getLead(projectId, leadId);
    if (!lead || lead.status === "trashed")
      throw new HomingError("not_found", "Object not found.", 404);
    const body = parseBody(commentSchema, await readJson(context));
    if (
      body.parent_id !== undefined &&
      !(await repository.getComment(projectId, leadId, body.parent_id))
    )
      throw new HomingError(
        "validation_error",
        "The parent comment must belong to this lead.",
        422,
      );
    const result = await idempotent(
      repository,
      principal,
      context.req.path,
      context.req.header("Idempotency-Key"),
      body,
      async (transaction) => {
        const comment: CommentRecord = {
          id: 0,
          leadId,
          authorId: principal.userId,
          body: body.body,
          parentId: body.parent_id ?? null,
          createdAt: now(),
          editedAt: null,
          deletedAt: null,
        };
        const created = await transaction.createComment(comment);
        await transaction.recordMutation(
          projectId,
          "comment.created",
          "comment",
          String(created.id),
          { lead_id: leadId },
          actor(context, principal),
        );
        return { status: 201, body: commentWire(created) };
      },
    );
    return json(context, result.status, result.body);
  });

  app.patch("/projects/:projectId/leads/:leadId/comments/:commentId", async (context) => {
    const { principal, projectId } = await leadAccess(context, "comments:write");
    const leadId = pathId(context, "leadId");
    const commentId = parseInteger(
      context.req.param("commentId"),
      0,
      1,
      Number.MAX_SAFE_INTEGER,
      "commentId",
    );
    const comment = await repository.getComment(projectId, leadId, commentId);
    if (!comment) throw new HomingError("not_found", "Object not found.", 404);
    if (
      comment.authorId !== principal.userId &&
      (await repository.getMembership(projectId, principal.userId))?.role !== "owner"
    )
      throw new HomingError("forbidden", "Comment permission is required.", 403);
    const body = parseBody(commentPatchSchema, await readJson(context));
    const updated = await repository.transaction(async (transaction) => {
      const result = await transaction.updateComment(commentId, {
        body: body.body,
        editedAt: now(),
      });
      await transaction.recordMutation(
        projectId,
        "comment.updated",
        "comment",
        String(commentId),
        { lead_id: leadId },
        actor(context, principal),
      );
      return result;
    });
    return json(context, 200, commentWire(updated));
  });

  app.delete("/projects/:projectId/leads/:leadId/comments/:commentId", async (context) => {
    const { principal, projectId } = await leadAccess(context, "comments:write");
    const leadId = pathId(context, "leadId");
    const commentId = parseInteger(
      context.req.param("commentId"),
      0,
      1,
      Number.MAX_SAFE_INTEGER,
      "commentId",
    );
    const comment = await repository.getComment(projectId, leadId, commentId);
    if (!comment) throw new HomingError("not_found", "Object not found.", 404);
    if (
      comment.authorId !== principal.userId &&
      (await repository.getMembership(projectId, principal.userId))?.role !== "owner"
    )
      throw new HomingError("forbidden", "Comment permission is required.", 403);
    await repository.transaction(async (transaction) => {
      await transaction.updateComment(commentId, { deletedAt: now() });
      await transaction.recordMutation(
        projectId,
        "comment.deleted",
        "comment",
        String(commentId),
        { lead_id: leadId },
        actor(context, principal),
        { tombstone: true },
      );
    });
    return new Response(null, { status: 204 });
  });

  return app;
}
