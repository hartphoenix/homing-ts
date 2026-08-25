import { type Context, Hono } from "hono";
import { formatChangeCursor, parseChangeCursor } from "./cursors";
import { forbidden, notFound, unauthorized, validation } from "./errors";
import { type AgentPrincipal, hasScope, isUuid, type ProjectAuthorizer } from "./runs";

export type ProjectChange = {
  sequence: number | bigint;
  eventType: string;
  objectType: string;
  objectId: string;
  payload: Record<string, unknown>;
  tombstone: boolean;
  occurredAt: Date;
};

export interface ChangeRepository {
  feedEpoch(projectId: string, principal: AgentPrincipal): Promise<string | null>;
  list(
    projectId: string,
    after: bigint,
    limit: number,
    principal: AgentPrincipal,
  ): Promise<ProjectChange[]>;
}

export class ChangeService {
  constructor(
    private readonly repository: ChangeRepository,
    private readonly authorize?: ProjectAuthorizer,
  ) {}

  async list(projectId: string, principal: AgentPrincipal | null, search: URLSearchParams) {
    if (!principal) throw unauthorized();
    if (!isUuid(projectId)) throw notFound();
    if (principal.projectIds?.length && !principal.projectIds.includes(projectId)) throw notFound();
    await this.authorize?.(principal, projectId, "projects:read");
    if (!hasScope(principal, "projects:read"))
      throw forbidden("The token does not have projects:read.");
    const epoch = await this.repository.feedEpoch(projectId, principal);
    if (!epoch) throw notFound();
    const cursor = parseChangeCursor(search.get("cursor"), epoch);
    const rawLimit = search.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw validation("limit must be an integer between 1 and 100");
    const changes = await this.repository.list(projectId, cursor.sequence, limit, principal);
    const visibleChanges = changes.filter((change) => {
      if (change.eventType.startsWith("prompt.")) return hasScope(principal, "prompts:read");
      if (change.eventType.startsWith("lead.")) return hasScope(principal, "leads:read");
      if (change.eventType.startsWith("interest.")) return hasScope(principal, "interest:read");
      if (change.eventType.startsWith("comment.")) return hasScope(principal, "comments:read");
      return true;
    });
    const items = visibleChanges.map((change) => ({
      sequence: typeof change.sequence === "bigint" ? Number(change.sequence) : change.sequence,
      event_type: change.eventType,
      object_type: change.objectType,
      object_id: change.objectId,
      payload: change.payload,
      tombstone: change.tombstone,
      occurred_at: change.occurredAt.toISOString(),
    }));
    const last = changes.at(-1)?.sequence ?? cursor.sequence;
    return { items, next_cursor: formatChangeCursor(epoch, last) };
  }
}

export class InMemoryChangeRepository implements ChangeRepository {
  readonly epochs = new Map<string, string>();
  readonly changes = new Map<string, ProjectChange[]>();
  seedProject(projectId: string, feedEpoch: string) {
    this.epochs.set(projectId, feedEpoch);
  }
  add(projectId: string, change: ProjectChange) {
    this.changes.set(projectId, [...(this.changes.get(projectId) ?? []), change]);
  }
  async feedEpoch(projectId: string) {
    return this.epochs.get(projectId) ?? null;
  }
  async list(projectId: string, after: bigint, limit: number) {
    return (this.changes.get(projectId) ?? [])
      .filter((item) => BigInt(item.sequence) > after)
      .sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence)))
      .slice(0, limit);
  }
}

export type ChangeRouterOptions = {
  service: ChangeService;
  principal: (context: Context) => Promise<AgentPrincipal | null> | AgentPrincipal | null;
};

export function createChangeRouter(options: ChangeRouterOptions): Hono {
  const app = new Hono();
  app.get("/projects/:projectId/changes", async (c) =>
    c.json(
      await options.service.list(
        c.req.param("projectId"),
        await options.principal(c),
        new URL(c.req.url).searchParams,
      ),
    ),
  );
  return app;
}
