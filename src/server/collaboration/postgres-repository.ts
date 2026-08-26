import { createHash, randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, gt, ilike, isNull, lt, or, sql } from "drizzle-orm";

import { getDatabase } from "../db/client";
import {
  auditEvents,
  idempotencyKeys,
  leadComments,
  leadInterests,
  leads,
  profiles,
  projectChanges,
  projectInvitations,
  projectMemberships,
  projects,
  promptRevisions,
  users,
} from "../db/schema";
import { HomingError } from "../http";
import type {
  BulkUpsertResult,
  CollaborationRepository,
  CommentRecord,
  IdempotencyRecord,
  InvitationRecord,
  LeadListOptions,
  LeadRecord,
  LeadStats,
  LeadStatus,
  LeadWrite,
  MembershipRecord,
  MutationActor,
  ProjectRecord,
  PromptRevisionRecord,
  Role,
} from "./types";

type Database = ReturnType<typeof getDatabase>;

function projectRecord(row: typeof projects.$inferSelect): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    currentPrompt: row.currentPrompt,
    criteria: row.criteria,
    status: row.status,
    creatorId: row.creatorId,
    promptRevision: row.promptRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function leadRecord(row: typeof leads.$inferSelect): LeadRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    source: row.source,
    sourceListingId: row.sourceListingId,
    canonicalUrl: row.canonicalUrl,
    identityHash: row.identityHash,
    sourceUrl: row.sourceUrl,
    title: row.title,
    summary: row.summary,
    location: row.location,
    priceDisplay: row.priceDisplay,
    priceAmount: row.priceAmount === null ? null : Number(row.priceAmount),
    priceCurrency: row.priceCurrency,
    availability: row.availability,
    housingType: row.housingType,
    dateConfidence: row.dateConfidence,
    listedAt: row.listedAt,
    parkNotes: row.parkNotes,
    attributes: row.attributes,
    verificationNotes: row.verificationNotes,
    status: row.status,
    trashedById: row.trashedById,
    trashedAt: row.trashedAt,
    creatorId: row.creatorId,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function promptRecord(row: typeof promptRevisions.$inferSelect): PromptRevisionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    revision: row.revision,
    prompt: row.prompt,
    criteria: row.criteria,
    editorId: row.editorId,
    createdAt: row.createdAt,
  };
}

function commentRecord(row: typeof leadComments.$inferSelect): CommentRecord {
  return {
    id: row.id,
    leadId: row.leadId,
    authorId: row.authorId,
    body: row.body,
    parentId: row.parentId,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
  };
}

function invitationRecord(row: typeof projectInvitations.$inferSelect): InvitationRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    email: row.email,
    role: row.role,
    inviterId: row.inviterId,
    tokenDigest: row.tokenDigest,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
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

function identityHash(url: string): string {
  return createHash("sha256").update(normalizeListingUrl(url)).digest("hex");
}

function requestedRevision(value: string): number | null {
  const normalized = value.trim().replace(/^W\//, "").replaceAll('"', "");
  return /^\d+$/.test(normalized) ? Number(normalized) : null;
}

function leadInsert(projectId: string, actorId: number, item: LeadWrite) {
  return {
    id: item.id,
    projectId,
    source: item.source,
    sourceListingId: item.source_listing_id ?? "",
    canonicalUrl: item.url,
    identityHash: identityHash(item.url),
    sourceUrl: item.source_url ?? "",
    title: item.title,
    summary: item.summary ?? "",
    location: item.location ?? "",
    priceDisplay: item.price_display ?? "",
    priceAmount: item.price_amount === undefined ? null : String(item.price_amount),
    priceCurrency: item.currency?.toUpperCase() ?? "USD",
    availability: item.availability ?? "",
    housingType: item.housing_type ?? "unknown",
    dateConfidence: item.date_confidence ?? "unknown",
    listedAt: item.listed_at ?? null,
    parkNotes: item.parks ?? "",
    attributes: item.attributes ?? {},
    verificationNotes: item.verification_notes ?? "",
    creatorId: actorId,
  } satisfies typeof leads.$inferInsert;
}

function leadPatchFromWrite(existing: LeadRecord, item: LeadWrite): Partial<LeadRecord> {
  return {
    source: item.source,
    sourceListingId: item.source_listing_id ?? existing.sourceListingId,
    canonicalUrl: item.url,
    identityHash: identityHash(item.url),
    sourceUrl: item.source_url ?? existing.sourceUrl,
    title: item.title,
    summary: item.summary ?? existing.summary,
    location: item.location ?? existing.location,
    priceDisplay: item.price_display ?? existing.priceDisplay,
    priceAmount: item.price_amount ?? existing.priceAmount,
    priceCurrency: item.currency?.toUpperCase() ?? existing.priceCurrency,
    availability: item.availability ?? existing.availability,
    housingType: item.housing_type ?? existing.housingType,
    dateConfidence: item.date_confidence ?? existing.dateConfidence,
    listedAt: item.listed_at === undefined ? existing.listedAt : item.listed_at,
    parkNotes: item.parks ?? existing.parkNotes,
    attributes: item.attributes ?? existing.attributes,
    verificationNotes: item.verification_notes ?? existing.verificationNotes,
  };
}

function leadChanged(existing: LeadRecord, patch: Partial<LeadRecord>): boolean {
  return Object.entries(patch).some(([key, value]) => {
    const current = existing[key as keyof LeadRecord];
    if (typeof value === "object") return JSON.stringify(current) !== JSON.stringify(value);
    return current !== value;
  });
}

/** Production persistence adapter. Mutating route handlers pass its transactional clone
 * through their complete mutation/change/audit unit so no durable side effect can split. */
export class PostgresCollaborationRepository implements CollaborationRepository {
  constructor(
    private readonly db: Database = getDatabase(),
    private readonly inTransaction = false,
  ) {}

  async transaction<T>(callback: (repository: CollaborationRepository) => Promise<T>): Promise<T> {
    if (this.inTransaction) return callback(this);
    return this.db.transaction((transaction) =>
      callback(new PostgresCollaborationRepository(transaction as unknown as Database, true)),
    );
  }

  async listProjects(userId: number): Promise<ProjectRecord[]> {
    const rows = await this.db
      .select({ project: projects })
      .from(projectMemberships)
      .innerJoin(projects, eq(projectMemberships.projectId, projects.id))
      .where(and(eq(projectMemberships.userId, userId), eq(projects.status, "active")))
      .orderBy(desc(projects.updatedAt), desc(projects.id));
    return rows.map(({ project }) => projectRecord(project));
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return row ? projectRecord(row) : null;
  }

  async createProject(
    input: Omit<ProjectRecord, "createdAt" | "updatedAt">,
  ): Promise<ProjectRecord> {
    const [row] = await this.db
      .insert(projects)
      .values({ ...input, feedEpoch: randomUUID() })
      .returning();
    if (!row) throw new HomingError("server_error", "The project could not be created.", 500);
    return projectRecord(row);
  }

  async updateProject(
    projectId: string,
    patch: Partial<Pick<ProjectRecord, "name" | "slug" | "description" | "status">>,
  ): Promise<ProjectRecord> {
    const [row] = await this.db
      .update(projects)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (!row) throw new HomingError("not_found", "Object not found.", 404);
    return projectRecord(row);
  }

  async getMembership(projectId: string, userId: number): Promise<MembershipRecord | null> {
    const [row] = await this.db
      .select({
        membership: projectMemberships,
        email: users.email,
        displayName: profiles.displayName,
      })
      .from(projectMemberships)
      .innerJoin(users, eq(projectMemberships.userId, users.id))
      .leftJoin(profiles, eq(projectMemberships.userId, profiles.userId))
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)),
      )
      .limit(1);
    return row
      ? {
          ...row.membership,
          email: row.email,
          displayName: row.displayName ?? row.email,
        }
      : null;
  }

  async listMemberships(projectId: string): Promise<MembershipRecord[]> {
    const rows = await this.db
      .select({
        membership: projectMemberships,
        email: users.email,
        displayName: profiles.displayName,
      })
      .from(projectMemberships)
      .innerJoin(users, eq(projectMemberships.userId, users.id))
      .leftJoin(profiles, eq(projectMemberships.userId, profiles.userId))
      .where(eq(projectMemberships.projectId, projectId))
      .orderBy(asc(projectMemberships.joinedAt), asc(projectMemberships.userId));
    return rows.map((row) => ({
      ...row.membership,
      email: row.email,
      displayName: row.displayName ?? row.email,
    }));
  }

  async countOwners(projectId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(projectMemberships)
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.role, "owner")),
      );
    return row?.value ?? 0;
  }

  async assertMembership(projectId: string, userId: number): Promise<void> {
    const status = await this.lockProject(projectId);
    if (status !== "active") throw new HomingError("not_found", "Object not found.", 404);
    if (!(await this.getMembership(projectId, userId))) {
      throw new HomingError("not_found", "Object not found.", 404);
    }
  }

  async assertOwner(projectId: string, userId: number, allowTrashed = false): Promise<void> {
    const status = await this.lockProject(projectId);
    if (!status || (!allowTrashed && status !== "active")) {
      throw new HomingError("not_found", "Object not found.", 404);
    }
    if ((await this.getMembership(projectId, userId))?.role !== "owner") {
      throw new HomingError("forbidden", "Owner permission is required.", 403);
    }
  }

  async upsertMembership(membership: MembershipRecord): Promise<MembershipRecord> {
    const [row] = await this.db
      .insert(projectMemberships)
      .values({
        projectId: membership.projectId,
        userId: membership.userId,
        role: membership.role,
        joinedAt: membership.joinedAt,
      })
      .onConflictDoUpdate({
        target: [projectMemberships.projectId, projectMemberships.userId],
        set: { role: membership.role },
      })
      .returning();
    if (!row) throw new HomingError("server_error", "The membership could not be saved.", 500);
    return { ...membership, ...row };
  }

  async removeMembership(projectId: string, userId: number): Promise<void> {
    await this.db
      .delete(projectMemberships)
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)),
      );
  }

  private async lockProject(projectId: string): Promise<ProjectRecord["status"] | null> {
    const [project] = await this.db
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .for("update");
    return project?.status ?? null;
  }

  async changeMembershipRole(
    projectId: string,
    userId: number,
    role: Role,
    actorId: number,
  ): Promise<MembershipRecord> {
    await this.assertOwner(projectId, actorId);
    const membership = await this.getMembership(projectId, userId);
    if (!membership) throw new HomingError("not_found", "Object not found.", 404);
    if (
      membership.role === "owner" &&
      role !== "owner" &&
      (await this.countOwners(projectId)) <= 1
    ) {
      throw new HomingError("final_owner", "A project must retain an owner.", 409);
    }
    return this.upsertMembership({ ...membership, role });
  }

  async removeMembershipSafely(projectId: string, userId: number, actorId: number): Promise<void> {
    await this.assertOwner(projectId, actorId);
    const membership = await this.getMembership(projectId, userId);
    if (!membership) throw new HomingError("not_found", "Object not found.", 404);
    if (userId === actorId) {
      throw new HomingError("self_removal", "Transfer ownership before removing yourself.", 409);
    }
    if (membership.role === "owner" && (await this.countOwners(projectId)) <= 1) {
      throw new HomingError("final_owner", "A project must retain an owner.", 409);
    }
    await this.removeMembership(projectId, userId);
  }

  async createInvitation(invitation: InvitationRecord): Promise<InvitationRecord> {
    const [row] = await this.db.insert(projectInvitations).values(invitation).returning();
    if (!row) throw new HomingError("server_error", "The invitation could not be created.", 500);
    return invitationRecord(row);
  }

  async listPendingInvitations(projectId: string, at: Date): Promise<InvitationRecord[]> {
    const rows = await this.db
      .select()
      .from(projectInvitations)
      .where(
        and(
          eq(projectInvitations.projectId, projectId),
          gt(projectInvitations.expiresAt, at),
          isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt),
        ),
      )
      .orderBy(desc(projectInvitations.createdAt));
    return rows.map(invitationRecord);
  }

  async revokeInvitation(projectId: string, invitationId: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(projectInvitations)
      .set({ revokedAt: at })
      .where(
        and(
          eq(projectInvitations.id, invitationId),
          eq(projectInvitations.projectId, projectId),
          gt(projectInvitations.expiresAt, at),
          isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt),
        ),
      )
      .returning({ id: projectInvitations.id });
    return rows.length === 1;
  }

  async getPrompt(projectId: string): Promise<PromptRevisionRecord | null> {
    const [revision] = await this.db
      .select()
      .from(promptRevisions)
      .where(eq(promptRevisions.projectId, projectId))
      .orderBy(desc(promptRevisions.revision))
      .limit(1);
    if (revision) return promptRecord(revision);
    const project = await this.getProject(projectId);
    return project
      ? {
          id: 0,
          projectId,
          revision: project.promptRevision,
          prompt: project.currentPrompt,
          criteria: project.criteria,
          editorId: null,
          createdAt: project.updatedAt,
        }
      : null;
  }

  async listPromptRevisions(projectId: string): Promise<PromptRevisionRecord[]> {
    const rows = await this.db
      .select()
      .from(promptRevisions)
      .where(eq(promptRevisions.projectId, projectId))
      .orderBy(desc(promptRevisions.revision));
    return rows.map(promptRecord);
  }

  async updatePrompt(
    projectId: string,
    expectedRevision: number,
    prompt: string,
    criteria: Record<string, unknown>,
    editorId: number,
  ): Promise<{ project: ProjectRecord; revision: PromptRevisionRecord }> {
    const [projectRow] = await this.db
      .update(projects)
      .set({
        currentPrompt: prompt,
        criteria,
        promptRevision: sql`${projects.promptRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, projectId), eq(projects.promptRevision, expectedRevision)))
      .returning();
    if (!projectRow) {
      const current = await this.getProject(projectId);
      if (!current) throw new HomingError("not_found", "Object not found.", 404);
      throw new HomingError("stale_write", "The prompt changed since it was read.", 409, {
        current_revision: current.promptRevision,
      });
    }
    const [revision] = await this.db
      .insert(promptRevisions)
      .values({ projectId, revision: projectRow.promptRevision, prompt, criteria, editorId })
      .returning();
    if (!revision)
      throw new HomingError("server_error", "The prompt revision could not be saved.", 500);
    return { project: projectRecord(projectRow), revision: promptRecord(revision) };
  }

  async listLeads(
    projectId: string,
    options: LeadListOptions,
  ): Promise<{ items: LeadRecord[]; total: number; next?: string }> {
    const conditions = [eq(leads.projectId, projectId), eq(leads.status, options.status)];
    const interestTotal = sql<number>`(
      select count(*)::int
      from ${leadInterests}
      inner join ${projectMemberships}
        on ${projectMemberships.userId} = ${leadInterests.userId}
        and ${projectMemberships.projectId} = ${leads.projectId}
      where ${leadInterests.leadId} = ${leads.id}
    )`;
    if (options.query) {
      const pattern = `%${options.query}%`;
      const queryCondition = or(
        ilike(leads.title, pattern),
        ilike(leads.summary, pattern),
        ilike(leads.location, pattern),
      );
      if (queryCondition) conditions.push(queryCondition);
    }
    if (options.interestedUserId !== undefined) {
      conditions.push(
        sql`exists (select 1 from ${leadInterests} where ${leadInterests.leadId} = ${leads.id} and ${leadInterests.userId} = ${options.interestedUserId})`,
      );
    } else if (options.interestedByAnyone) {
      conditions.push(
        sql`exists (
          select 1
          from ${leadInterests}
          inner join ${projectMemberships}
            on ${projectMemberships.userId} = ${leadInterests.userId}
            and ${projectMemberships.projectId} = ${leads.projectId}
          where ${leadInterests.leadId} = ${leads.id}
        )`,
      );
    }

    const [totalRow] = await this.db
      .select({ value: count() })
      .from(leads)
      .where(and(...conditions));
    const total = totalRow?.value ?? 0;

    const sort = options.sort ?? "updated";
    if (options.after) {
      const cursor = await this.getLead(projectId, options.after);
      if (!cursor) return { items: [], total };
      if (sort === "price_asc" || sort === "price_desc") {
        const ascending = sort === "price_asc";
        const cursorCondition =
          cursor.priceAmount === null
            ? ascending
              ? and(isNull(leads.priceAmount), gt(leads.id, cursor.id))
              : and(isNull(leads.priceAmount), lt(leads.id, cursor.id))
            : or(
                isNull(leads.priceAmount),
                ascending
                  ? gt(leads.priceAmount, String(cursor.priceAmount))
                  : lt(leads.priceAmount, String(cursor.priceAmount)),
                and(
                  eq(leads.priceAmount, String(cursor.priceAmount)),
                  ascending ? gt(leads.id, cursor.id) : lt(leads.id, cursor.id),
                ),
              );
        if (cursorCondition) conditions.push(cursorCondition);
      } else if (sort === "source_asc" || sort === "source_desc") {
        const ascending = sort === "source_asc";
        const cursorCondition = or(
          ascending ? gt(leads.source, cursor.source) : lt(leads.source, cursor.source),
          and(
            eq(leads.source, cursor.source),
            ascending ? gt(leads.id, cursor.id) : lt(leads.id, cursor.id),
          ),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      } else if (sort === "days_asc" || sort === "days_desc") {
        const newestFirst = sort === "days_asc";
        const cursorCondition =
          cursor.listedAt === null
            ? and(isNull(leads.listedAt), gt(leads.id, cursor.id))
            : or(
                isNull(leads.listedAt),
                newestFirst
                  ? lt(leads.listedAt, cursor.listedAt)
                  : gt(leads.listedAt, cursor.listedAt),
                and(eq(leads.listedAt, cursor.listedAt), gt(leads.id, cursor.id)),
              );
        if (cursorCondition) conditions.push(cursorCondition);
      } else if (sort === "oldest") {
        const cursorCondition = or(
          gt(leads.createdAt, cursor.createdAt),
          and(eq(leads.createdAt, cursor.createdAt), gt(leads.id, cursor.id)),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      } else if (sort === "newest") {
        const cursorCondition = or(
          lt(leads.createdAt, cursor.createdAt),
          and(eq(leads.createdAt, cursor.createdAt), lt(leads.id, cursor.id)),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      } else if (sort === "interest") {
        const cursorStats = await this.getLeadStats(projectId, cursor.id, 0);
        const cursorCondition = or(
          lt(interestTotal, cursorStats.interestCount),
          and(
            eq(interestTotal, cursorStats.interestCount),
            or(
              lt(leads.updatedAt, cursor.updatedAt),
              and(eq(leads.updatedAt, cursor.updatedAt), lt(leads.id, cursor.id)),
            ),
          ),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      } else {
        const cursorCondition = or(
          lt(leads.updatedAt, cursor.updatedAt),
          and(eq(leads.updatedAt, cursor.updatedAt), lt(leads.id, cursor.id)),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      }
    }

    const order =
      sort === "oldest"
        ? [asc(leads.createdAt), asc(leads.id)]
        : sort === "newest"
          ? [desc(leads.createdAt), desc(leads.id)]
          : sort === "interest"
            ? [desc(interestTotal), desc(leads.updatedAt), desc(leads.id)]
            : sort === "price_asc"
              ? [asc(sql`${leads.priceAmount} is null`), asc(leads.priceAmount), asc(leads.id)]
              : sort === "price_desc"
                ? [asc(sql`${leads.priceAmount} is null`), desc(leads.priceAmount), desc(leads.id)]
                : sort === "source_asc"
                  ? [asc(leads.source), asc(leads.id)]
                  : sort === "source_desc"
                    ? [desc(leads.source), desc(leads.id)]
                    : sort === "days_asc"
                      ? [asc(sql`${leads.listedAt} is null`), desc(leads.listedAt), asc(leads.id)]
                      : sort === "days_desc"
                        ? [asc(sql`${leads.listedAt} is null`), asc(leads.listedAt), asc(leads.id)]
                        : [desc(leads.updatedAt), desc(leads.id)];
    const rows = await this.db
      .select()
      .from(leads)
      .where(and(...conditions))
      .orderBy(...order)
      .limit(options.limit + 1);
    const hasNext = rows.length > options.limit;
    const page = rows.slice(0, options.limit).map(leadRecord);
    const last = page.at(-1);
    return { items: page, total, ...(hasNext && last ? { next: last.id } : {}) };
  }

  async getLead(projectId: string, leadId: string): Promise<LeadRecord | null> {
    const [row] = await this.db
      .select()
      .from(leads)
      .where(and(eq(leads.projectId, projectId), eq(leads.id, leadId)))
      .limit(1);
    return row ? leadRecord(row) : null;
  }

  async createLead(lead: LeadRecord): Promise<LeadRecord> {
    const [row] = await this.db
      .insert(leads)
      .values({
        ...lead,
        priceAmount: lead.priceAmount === null ? null : String(lead.priceAmount),
      })
      .returning();
    if (!row) throw new HomingError("server_error", "The lead could not be created.", 500);
    return leadRecord(row);
  }

  async updateLead(
    projectId: string,
    leadId: string,
    expectedRevision: number,
    patch: Partial<LeadRecord>,
  ): Promise<LeadRecord> {
    const { priceAmount, ...rest } = patch;
    const values = {
      ...rest,
      ...(priceAmount !== undefined
        ? { priceAmount: priceAmount === null ? null : String(priceAmount) }
        : {}),
      revision: sql`${leads.revision} + 1`,
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .update(leads)
      .set(values)
      .where(
        and(
          eq(leads.projectId, projectId),
          eq(leads.id, leadId),
          eq(leads.revision, expectedRevision),
          eq(leads.status, "active"),
        ),
      )
      .returning();
    if (!row) {
      const current = await this.getLead(projectId, leadId);
      if (!current) throw new HomingError("not_found", "Object not found.", 404);
      if (current.status !== "active") throw new HomingError("not_found", "Object not found.", 404);
      throw new HomingError("stale_write", "The lead changed since it was read.", 409, {
        current_revision: current.revision,
      });
    }
    return leadRecord(row);
  }

  async bulkUpsertLeads(
    projectId: string,
    actorId: number,
    items: LeadWrite[],
  ): Promise<BulkUpsertResult[]> {
    await this.lockProject(projectId);
    const results: BulkUpsertResult[] = [];
    for (const item of items) {
      const fallbackHash = identityHash(item.url);
      const [row] = await this.db
        .select()
        .from(leads)
        .where(
          item.source_listing_id
            ? and(
                eq(leads.projectId, projectId),
                eq(leads.source, item.source),
                eq(leads.sourceListingId, item.source_listing_id),
              )
            : and(eq(leads.projectId, projectId), eq(leads.identityHash, fallbackHash)),
        )
        .limit(1);
      const existing = row ? leadRecord(row) : null;
      const [urlOwner] = await this.db
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.projectId, projectId), eq(leads.identityHash, fallbackHash)))
        .limit(1);
      const [idOwner] = item.id
        ? await this.db.select({ id: leads.id }).from(leads).where(eq(leads.id, item.id)).limit(1)
        : [];
      if ((urlOwner && urlOwner.id !== existing?.id) || (idOwner && idOwner.id !== existing?.id)) {
        results.push({
          outcome: "conflict",
          error: {
            code: "identity_conflict",
            message: "A lead with this identity already exists.",
          },
        });
        continue;
      }
      if (existing?.status === "trashed") {
        results.push({
          outcome: "conflict",
          error: { code: "lead_trashed", message: "Trashed leads are not silently restored." },
        });
        continue;
      }
      if (existing) {
        if (!item.if_match) {
          results.push({
            outcome: "conflict",
            error: {
              code: "if_match_required",
              message: "if_match is required when updating an existing lead.",
            },
          });
          continue;
        }
        if (requestedRevision(item.if_match) !== existing.revision) {
          results.push({
            outcome: "conflict",
            error: { code: "stale_write", message: "The lead changed since it was read." },
          });
          continue;
        }
        const patch = leadPatchFromWrite(existing, item);
        if (!leadChanged(existing, patch)) {
          results.push({ outcome: "unchanged", lead: existing });
          continue;
        }
        results.push({
          outcome: "updated",
          lead: await this.updateLead(projectId, existing.id, existing.revision, patch),
        });
        continue;
      }
      const [created] = await this.db
        .insert(leads)
        .values(leadInsert(projectId, actorId, item))
        .returning();
      if (!created) {
        results.push({
          outcome: "error",
          error: { code: "server_error", message: "The lead could not be saved." },
        });
      } else {
        results.push({ outcome: "created", lead: leadRecord(created) });
      }
    }
    return results;
  }

  async setLeadStatus(
    projectId: string,
    leadId: string,
    status: LeadStatus,
    actorId: number,
    expectedRevision?: number,
  ): Promise<LeadRecord> {
    const conditions = [eq(leads.projectId, projectId), eq(leads.id, leadId)];
    if (expectedRevision !== undefined) conditions.push(eq(leads.revision, expectedRevision));
    const [row] = await this.db
      .update(leads)
      .set({
        status,
        trashedById: status === "trashed" ? actorId : null,
        trashedAt: status === "trashed" ? new Date() : null,
        revision: sql`${leads.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning();
    if (!row) {
      const current = await this.getLead(projectId, leadId);
      if (!current) throw new HomingError("not_found", "Object not found.", 404);
      throw new HomingError("stale_write", "The lead changed since it was read.", 409, {
        current_revision: current.revision,
      });
    }
    return leadRecord(row);
  }

  async permanentlyDeleteLead(projectId: string, leadId: string): Promise<void> {
    const rows = await this.db
      .delete(leads)
      .where(and(eq(leads.projectId, projectId), eq(leads.id, leadId)))
      .returning({ id: leads.id });
    if (rows.length === 0) throw new HomingError("not_found", "Object not found.", 404);
  }

  async getInterest(projectId: string, leadId: string, userId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ leadId: leadInterests.leadId })
      .from(leadInterests)
      .innerJoin(leads, eq(leadInterests.leadId, leads.id))
      .where(
        and(
          eq(leads.projectId, projectId),
          eq(leadInterests.leadId, leadId),
          eq(leadInterests.userId, userId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async getLeadStats(projectId: string, leadId: string, userId: number): Promise<LeadStats> {
    const interestedRows = await this.db
      .select({
        userId: projectMemberships.userId,
        displayName: profiles.displayName,
        email: users.email,
      })
      .from(leadInterests)
      .innerJoin(leads, eq(leadInterests.leadId, leads.id))
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.projectId, leads.projectId),
          eq(projectMemberships.userId, leadInterests.userId),
        ),
      )
      .innerJoin(users, eq(leadInterests.userId, users.id))
      .leftJoin(profiles, eq(leadInterests.userId, profiles.userId))
      .where(and(eq(leads.projectId, projectId), eq(leads.id, leadId)));
    const [comments] = await this.db
      .select({ value: count() })
      .from(leadComments)
      .where(and(eq(leadComments.leadId, leadId), isNull(leadComments.deletedAt)));
    return {
      interested: interestedRows.some((row) => row.userId === userId),
      interestCount: interestedRows.length,
      interestedUsers: interestedRows.map((row) => row.displayName || row.email || "Member"),
      commentCount: comments?.value ?? 0,
    };
  }

  async setInterest(
    projectId: string,
    leadId: string,
    userId: number,
    interested: boolean,
  ): Promise<boolean> {
    const lead = await this.getLead(projectId, leadId);
    if (lead?.status !== "active") throw new HomingError("not_found", "Object not found.", 404);
    if (interested) {
      await this.db
        .insert(leadInterests)
        .values({ leadId, userId })
        .onConflictDoNothing({ target: [leadInterests.leadId, leadInterests.userId] });
    } else {
      await this.db
        .delete(leadInterests)
        .where(and(eq(leadInterests.leadId, leadId), eq(leadInterests.userId, userId)));
    }
    return interested;
  }

  async listComments(projectId: string, leadId: string): Promise<CommentRecord[]> {
    const rows = await this.db
      .select({ comment: leadComments })
      .from(leadComments)
      .innerJoin(leads, eq(leadComments.leadId, leads.id))
      .where(
        and(
          eq(leads.projectId, projectId),
          eq(leadComments.leadId, leadId),
          isNull(leadComments.deletedAt),
        ),
      )
      .orderBy(asc(leadComments.createdAt), asc(leadComments.id));
    return rows.map(({ comment }) => commentRecord(comment));
  }

  async createComment(comment: CommentRecord): Promise<CommentRecord> {
    const [row] = await this.db
      .insert(leadComments)
      .values({
        leadId: comment.leadId,
        authorId: comment.authorId,
        body: comment.body,
        parentId: comment.parentId,
        createdAt: comment.createdAt,
      })
      .returning();
    if (!row) throw new HomingError("server_error", "The comment could not be created.", 500);
    return commentRecord(row);
  }

  async updateComment(id: number, patch: Partial<CommentRecord>): Promise<CommentRecord> {
    const [row] = await this.db
      .update(leadComments)
      .set(patch)
      .where(eq(leadComments.id, id))
      .returning();
    if (!row) throw new HomingError("not_found", "Object not found.", 404);
    return commentRecord(row);
  }

  async getComment(
    projectId: string,
    leadId: string,
    commentId: number,
  ): Promise<CommentRecord | null> {
    const [row] = await this.db
      .select({ comment: leadComments })
      .from(leadComments)
      .innerJoin(leads, eq(leadComments.leadId, leads.id))
      .where(
        and(
          eq(leads.projectId, projectId),
          eq(leadComments.leadId, leadId),
          eq(leadComments.id, commentId),
          isNull(leadComments.deletedAt),
        ),
      )
      .limit(1);
    return row ? commentRecord(row.comment) : null;
  }

  async getIdempotency(
    userId: number,
    tokenId: string | null,
    endpoint: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const [row] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          tokenId === null ? isNull(idempotencyKeys.tokenId) : eq(idempotencyKeys.tokenId, tokenId),
          eq(idempotencyKeys.endpoint, endpoint),
          eq(idempotencyKeys.key, key),
        ),
      )
      .limit(1);
    if (row && row.expiresAt <= new Date()) {
      await this.db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, row.id));
      return null;
    }
    return row
      ? {
          userId: row.userId,
          tokenId: row.tokenId,
          endpoint: row.endpoint,
          key: row.key,
          requestHash: row.requestHash,
          responseStatus: row.responseStatus ?? 200,
          responseBody: row.responseBody,
          expiresAt: row.expiresAt,
        }
      : null;
  }

  async lockIdempotency(
    userId: number,
    tokenId: string | null,
    endpoint: string,
    key: string,
  ): Promise<void> {
    const identity = JSON.stringify([userId, tokenId, endpoint, key]);
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`);
  }

  async putIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    await this.db.insert(idempotencyKeys).values({
      userId: record.userId,
      tokenId: record.tokenId,
      endpoint: record.endpoint,
      key: record.key,
      requestHash: record.requestHash,
      responseStatus: record.responseStatus,
      responseBody: record.responseBody,
      expiresAt: record.expiresAt,
    });
    return record;
  }

  async recordMutation(
    projectId: string,
    eventType: string,
    objectType: string,
    objectId: string,
    payload: Record<string, unknown>,
    actor: MutationActor,
    options: { tombstone?: boolean; audit?: boolean } = {},
  ): Promise<void> {
    const [project] = await this.db
      .update(projects)
      .set({
        latestChangeSequence: sql`${projects.latestChangeSequence} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning({ sequence: projects.latestChangeSequence });
    if (!project) throw new HomingError("not_found", "Object not found.", 404);
    await this.db.insert(projectChanges).values({
      projectId,
      sequence: project.sequence,
      eventType,
      objectType,
      objectId,
      payload,
      tombstone: options.tombstone ?? false,
      actorId: actor.userId,
      actorKind: actor.actorKind,
      tokenId: actor.tokenId,
    });
    if (options.audit !== false) {
      await this.db.insert(auditEvents).values({
        projectId,
        action: eventType,
        objectType,
        objectId,
        actorKind: actor.actorKind,
        actorId: actor.userId,
        tokenId: actor.tokenId,
        requestId: actor.requestId.slice(0, 80),
        summary: payload,
      });
    }
  }
}
