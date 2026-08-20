import { randomUUID } from "node:crypto";

import { type Context, Hono } from "hono";
import { conflict, forbidden, notFound, unauthorized, validation } from "./errors";
import { type AgentPrincipal, hasScope, isUuid, type ProjectAuthorizer } from "./runs";

export type SourcePlanReview = {
  id: string;
  projectId: string;
  userId: number;
  status: "open" | "resolved";
  observedPromptRevision: number;
  resolvedPromptRevision: number | null;
  openedAt: Date;
  lastReportedAt: Date;
  resolvedAt: Date | null;
};

export interface SourcePlanRepository {
  currentPromptRevision(projectId: string, principal: AgentPrincipal): Promise<number | null>;
  listOpen(userId: number, principal: AgentPrincipal): Promise<SourcePlanReview[]>;
  open(
    projectId: string,
    userId: number,
    tokenId: string | null,
    promptRevision: number,
    now: Date,
  ): Promise<{ review: SourcePlanReview; created: boolean }>;
  find(projectId: string, reviewId: string, userId: number): Promise<SourcePlanReview | null>;
  resolve(
    review: SourcePlanReview,
    tokenId: string | null,
    promptRevision: number,
    now: Date,
  ): Promise<SourcePlanReview>;
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_147_483_647)
    throw validation("prompt_revision must be an integer");
  return value;
}

function json(review: SourcePlanReview) {
  return {
    id: review.id,
    project_id: review.projectId,
    status: review.status,
    observed_prompt_revision: review.observedPromptRevision,
    resolved_prompt_revision: review.resolvedPromptRevision,
    opened_at: review.openedAt.toISOString(),
    last_reported_at: review.lastReportedAt.toISOString(),
    resolved_at: review.resolvedAt?.toISOString() ?? null,
  };
}

export class SourcePlanService {
  constructor(
    private readonly repository: SourcePlanRepository,
    private readonly authorize?: ProjectAuthorizer,
  ) {}

  async principal(principal: AgentPrincipal | null): Promise<AgentPrincipal> {
    if (!principal) throw unauthorized();
    return principal;
  }

  async project(principal: AgentPrincipal, projectId: string): Promise<void> {
    if (!isUuid(projectId)) throw notFound();
    if (principal.projectIds?.length && !principal.projectIds.includes(projectId)) throw notFound();
    await this.authorize?.(principal, projectId, "runs:write");
    if (!hasScope(principal, "runs:write")) throw forbidden("The token does not have runs:write.");
  }

  async list(principal: AgentPrincipal | null) {
    const user = await this.principal(principal);
    if (!hasScope(user, "projects:read")) throw forbidden("The token does not have projects:read.");
    const reviews = await this.repository.listOpen(user.userId, user);
    const allowed = user.projectIds?.length
      ? reviews.filter((item) => user.projectIds?.includes(item.projectId))
      : reviews;
    return { items: allowed.slice(0, 100).map(json) };
  }

  async report(principal: AgentPrincipal, projectId: string, raw: unknown) {
    await this.project(principal, projectId);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw validation("JSON object required");
    const body = raw as Record<string, unknown>;
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "prompt_revision")
      throw validation("Only prompt_revision is accepted");
    const promptRevision = revision(body.prompt_revision);
    const current = await this.repository.currentPromptRevision(projectId, principal);
    if (current === null) throw notFound();
    if (promptRevision !== current)
      throw conflict(
        "stale_prompt_revision",
        "The project prompt has changed; read it again before reporting.",
        { prompt_revision: [`current revision is ${current}`] },
      );
    const result = await this.repository.open(
      projectId,
      principal.userId,
      principal.tokenId ?? null,
      promptRevision,
      new Date(),
    );
    return { body: json(result.review), status: result.created ? 201 : 200 };
  }

  async resolve(principal: AgentPrincipal, projectId: string, reviewId: string, raw: unknown) {
    await this.project(principal, projectId);
    if (!isUuid(reviewId)) throw notFound();
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw validation("JSON object required");
    const body = raw as Record<string, unknown>;
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "prompt_revision")
      throw validation("Only prompt_revision is accepted");
    const promptRevision = revision(body.prompt_revision);
    const review = await this.repository.find(projectId, reviewId, principal.userId);
    if (!review) throw notFound();
    const current = await this.repository.currentPromptRevision(projectId, principal);
    if (current === null) throw notFound();
    if (promptRevision !== current)
      throw conflict(
        "stale_prompt_revision",
        "The project prompt has changed; read it again before resolving.",
        { prompt_revision: [`current revision is ${current}`] },
      );
    if (review.status === "resolved") {
      if (review.resolvedPromptRevision === promptRevision) return json(review);
      throw conflict(
        "source_plan_review_stale",
        "Report the current prompt revision before resolving.",
      );
    }
    if (review.observedPromptRevision !== current)
      throw conflict(
        "source_plan_review_stale",
        "Report the current prompt revision before resolving.",
      );
    return json(
      await this.repository.resolve(review, principal.tokenId ?? null, promptRevision, new Date()),
    );
  }

  prompt(origin: string): string {
    const base = new URL(origin);
    if (base.protocol !== "http:" && base.protocol !== "https:")
      throw new Error("Invalid configured origin");
    return `Repair the source plan Homing has flagged for my housing searches.\n\nRead ${base.origin}/agent/ and follow it exactly. Work with the existing installation; do not create a second scheduled job. Read the open source-plan reviews and current project prompts from Homing. Compare them with the installed sources and basis. Decide whether the worker-wide source union still fits. If it does, avoid expensive discovery and update the basis through the normal repair path. Otherwise focus discovery on the flagged searches, then rebuild the global union without dropping coverage for other current searches.\n\nRun the package self-test and one on-demand check. Resolve each review only after the verified installation records the current prompt revision. If a prompt changes during repair, re-read it and repeat the comparison. Never ask me to paste a password or access key into this chat. Ask one plain human question at a time only when a real choice is genuinely gated.`;
  }
}

export class InMemorySourcePlanRepository implements SourcePlanRepository {
  readonly projects = new Map<string, number>();
  readonly reviews = new Map<string, SourcePlanReview>();

  seedProject(projectId: string, promptRevision: number) {
    this.projects.set(projectId, promptRevision);
  }
  async currentPromptRevision(projectId: string) {
    return this.projects.get(projectId) ?? null;
  }
  async listOpen(userId: number) {
    return [...this.reviews.values()].filter(
      (review) => review.userId === userId && review.status === "open",
    );
  }
  async open(
    projectId: string,
    userId: number,
    _tokenId: string | null,
    promptRevision: number,
    now: Date,
  ) {
    const existing = [...this.reviews.values()].find(
      (review) =>
        review.projectId === projectId && review.userId === userId && review.status === "open",
    );
    if (existing) {
      existing.observedPromptRevision = promptRevision;
      existing.lastReportedAt = now;
      return { review: existing, created: false };
    }
    const review: SourcePlanReview = {
      id: randomUUID(),
      projectId,
      userId,
      status: "open",
      observedPromptRevision: promptRevision,
      resolvedPromptRevision: null,
      openedAt: now,
      lastReportedAt: now,
      resolvedAt: null,
    };
    this.reviews.set(review.id, review);
    return { review, created: true };
  }
  async find(projectId: string, reviewId: string, userId: number) {
    const review = this.reviews.get(reviewId);
    return review && review.projectId === projectId && review.userId === userId ? review : null;
  }
  async resolve(
    review: SourcePlanReview,
    _tokenId: string | null,
    promptRevision: number,
    now: Date,
  ) {
    review.status = "resolved";
    review.resolvedPromptRevision = promptRevision;
    review.resolvedAt = now;
    return review;
  }
}

export type SourcePlanRouterOptions = {
  service: SourcePlanService;
  principal: (context: Context) => Promise<AgentPrincipal | null> | AgentPrincipal | null;
  origin: string;
};

export function createSourcePlanRouter(options: SourcePlanRouterOptions): Hono {
  const app = new Hono();
  app.get("/me/source-plan-reviews", async (c) => {
    const search = new URL(c.req.url).searchParams;
    const keys = [...search.keys()];
    if (
      keys.length > 1 ||
      (keys.length === 1 && (keys[0] !== "status" || search.get("status") !== "open"))
    ) {
      throw validation("Only status=open is supported");
    }
    return c.json(await options.service.list(await options.principal(c)));
  });
  app.post("/projects/:projectId/source-plan-review", async (c) => {
    const principal = await options.service.principal(await options.principal(c));
    const result = await options.service.report(
      principal,
      c.req.param("projectId"),
      await c.req.json().catch(() => null),
    );
    return c.json(result.body, result.status as 200 | 201);
  });
  app.post("/projects/:projectId/source-plan-review/:reviewId/resolve", async (c) => {
    const principal = await options.service.principal(await options.principal(c));
    return c.json(
      await options.service.resolve(
        principal,
        c.req.param("projectId"),
        c.req.param("reviewId"),
        await c.req.json().catch(() => null),
      ),
    );
  });
  app.get("/me/source-plan-repair", async (c) => {
    const principal = await options.service.principal(await options.principal(c));
    const items = await options.service.list(principal);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      open_review_count: items.items.length,
      prompt: options.service.prompt(options.origin),
    });
  });
  return app;
}
