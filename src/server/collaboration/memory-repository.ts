import { createHash } from "node:crypto";

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
  ProjectRecord,
  PromptRevisionRecord,
  Role,
} from "./types";

function copy<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((entry) => copy(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, copy(entry)]),
    ) as T;
  }
  return value;
}

function hash(value: string): string {
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

function copyMap<K, V>(source: Map<K, V>): Map<K, V> {
  return new Map([...source.entries()].map(([key, value]) => [key, copy(value)]));
}

function identityKey(
  item: Pick<LeadRecord, "source" | "sourceListingId" | "identityHash" | "canonicalUrl">,
): string {
  if (item.sourceListingId) return `source:${item.source}\u0000${item.sourceListingId}`;
  if (item.identityHash) return `identity:${item.identityHash}`;
  return `url:${item.canonicalUrl}`;
}

function projectKey(projectId: string, leadId: string): string {
  return `${projectId}:${leadId}`;
}

/**
 * Small deterministic repository used by focused tests and local development.
 * It intentionally implements the same atomic boundaries required from the
 * PostgreSQL adapter, including rollback on failed transactions.
 */
export class InMemoryCollaborationRepository implements CollaborationRepository {
  private projects = new Map<string, ProjectRecord>();
  private memberships = new Map<string, MembershipRecord>();
  private invitations = new Map<string, InvitationRecord>();
  private promptRevisions = new Map<string, PromptRevisionRecord[]>();
  private leads = new Map<string, LeadRecord>();
  private interests = new Set<string>();
  private comments = new Map<number, CommentRecord>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private nextCommentId = 1;
  private nextPromptId = 1;

  constructor(
    seed: {
      projects?: ProjectRecord[];
      memberships?: MembershipRecord[];
      invitations?: InvitationRecord[];
      promptRevisions?: PromptRevisionRecord[];
      leads?: LeadRecord[];
      interests?: Array<{ projectId: string; leadId: string; userId: number }>;
      comments?: CommentRecord[];
      idempotency?: IdempotencyRecord[];
    } = {},
  ) {
    for (const project of seed.projects ?? []) this.projects.set(project.id, copy(project));
    for (const membership of seed.memberships ?? []) {
      this.memberships.set(
        this.membershipKey(membership.projectId, membership.userId),
        copy(membership),
      );
    }
    for (const invitation of seed.invitations ?? [])
      this.invitations.set(invitation.id, copy(invitation));
    for (const revision of seed.promptRevisions ?? []) {
      const revisions = this.promptRevisions.get(revision.projectId) ?? [];
      revisions.push(copy(revision));
      this.promptRevisions.set(revision.projectId, revisions);
      this.nextPromptId = Math.max(this.nextPromptId, revision.id + 1);
    }
    for (const lead of seed.leads ?? [])
      this.leads.set(projectKey(lead.projectId, lead.id), copy(lead));
    for (const interest of seed.interests ?? [])
      this.interests.add(this.interestKey(interest.projectId, interest.leadId, interest.userId));
    for (const comment of seed.comments ?? []) {
      this.comments.set(comment.id, copy(comment));
      this.nextCommentId = Math.max(this.nextCommentId, comment.id + 1);
    }
    for (const record of seed.idempotency ?? [])
      this.idempotency.set(
        this.idempotencyKey(record.userId, record.tokenId, record.endpoint, record.key),
        copy(record),
      );
  }

  private membershipKey(projectId: string, userId: number): string {
    return `${projectId}:${userId}`;
  }

  private interestKey(projectId: string, leadId: string, userId: number): string {
    return `${projectId}:${leadId}:${userId}`;
  }

  private idempotencyKey(
    userId: number,
    tokenId: string | null,
    endpoint: string,
    key: string,
  ): string {
    return `${userId}:${tokenId ?? "session"}:${endpoint}:${key}`;
  }

  private interestCount(projectId: string, leadId: string): number {
    return [...this.memberships.values()].filter(
      (membership) =>
        membership.projectId === projectId &&
        this.interests.has(this.interestKey(projectId, leadId, membership.userId)),
    ).length;
  }

  async transaction<T>(callback: (repository: CollaborationRepository) => Promise<T>): Promise<T> {
    const snapshot = {
      projects: copyMap(this.projects),
      memberships: copyMap(this.memberships),
      invitations: copyMap(this.invitations),
      promptRevisions: copyMap(this.promptRevisions),
      leads: copyMap(this.leads),
      interests: new Set(this.interests),
      comments: copyMap(this.comments),
      idempotency: copyMap(this.idempotency),
      nextCommentId: this.nextCommentId,
      nextPromptId: this.nextPromptId,
    };
    try {
      return await callback(this);
    } catch (error) {
      this.projects = snapshot.projects;
      this.memberships = snapshot.memberships;
      this.invitations = snapshot.invitations;
      this.promptRevisions = snapshot.promptRevisions;
      this.leads = snapshot.leads;
      this.interests = snapshot.interests;
      this.comments = snapshot.comments;
      this.idempotency = snapshot.idempotency;
      this.nextCommentId = snapshot.nextCommentId;
      this.nextPromptId = snapshot.nextPromptId;
      throw error;
    }
  }

  async listProjects(userId: number): Promise<ProjectRecord[]> {
    const ids = [...this.memberships.values()]
      .filter((membership) => membership.userId === userId)
      .map((membership) => membership.projectId);
    return ids
      .map((id) => this.projects.get(id))
      .filter((project): project is ProjectRecord =>
        Boolean(project && project.status === "active"),
      )
      .map(copy);
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const project = this.projects.get(projectId);
    return project ? copy(project) : null;
  }

  async createProject(
    input: Omit<ProjectRecord, "createdAt" | "updatedAt">,
  ): Promise<ProjectRecord> {
    const now = new Date();
    const project = { ...copy(input), createdAt: now, updatedAt: now };
    if (this.projects.has(project.id))
      throw new HomingError("conflict", "Project already exists.", 409);
    this.projects.set(project.id, project);
    return copy(project);
  }

  async updateProject(
    projectId: string,
    patch: Partial<Pick<ProjectRecord, "name" | "slug" | "description" | "status">>,
  ): Promise<ProjectRecord> {
    const project = this.projects.get(projectId);
    if (!project) throw new HomingError("not_found", "Object not found.", 404);
    Object.assign(project, copy(patch), { updatedAt: new Date() });
    return copy(project);
  }

  async getMembership(projectId: string, userId: number): Promise<MembershipRecord | null> {
    const membership = this.memberships.get(this.membershipKey(projectId, userId));
    return membership ? copy(membership) : null;
  }

  async listMemberships(projectId: string): Promise<MembershipRecord[]> {
    return [...this.memberships.values()]
      .filter((membership) => membership.projectId === projectId)
      .map(copy);
  }

  async countOwners(projectId: string): Promise<number> {
    return [...this.memberships.values()].filter(
      (membership) => membership.projectId === projectId && membership.role === "owner",
    ).length;
  }

  async assertMembership(projectId: string, userId: number): Promise<void> {
    if (this.projects.get(projectId)?.status !== "active") {
      throw new HomingError("not_found", "Object not found.", 404);
    }
    if (!(await this.getMembership(projectId, userId))) {
      throw new HomingError("not_found", "Object not found.", 404);
    }
  }

  async assertOwner(projectId: string, userId: number, allowTrashed = false): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project || (!allowTrashed && project.status !== "active")) {
      throw new HomingError("not_found", "Object not found.", 404);
    }
    if ((await this.getMembership(projectId, userId))?.role !== "owner") {
      throw new HomingError("forbidden", "Owner permission is required.", 403);
    }
  }

  async upsertMembership(membership: MembershipRecord): Promise<MembershipRecord> {
    const value = copy(membership);
    this.memberships.set(this.membershipKey(value.projectId, value.userId), value);
    return copy(value);
  }

  async removeMembership(projectId: string, userId: number): Promise<void> {
    this.memberships.delete(this.membershipKey(projectId, userId));
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
    const value = copy(invitation);
    this.invitations.set(value.id, value);
    return copy(value);
  }

  async listPendingInvitations(projectId: string, at: Date): Promise<InvitationRecord[]> {
    return [...this.invitations.values()]
      .filter(
        (invitation) =>
          invitation.projectId === projectId &&
          invitation.expiresAt > at &&
          invitation.acceptedAt === null &&
          invitation.revokedAt === null,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(copy);
  }

  async revokeInvitation(projectId: string, invitationId: string, at: Date): Promise<boolean> {
    const invitation = this.invitations.get(invitationId);
    if (
      !invitation ||
      invitation.projectId !== projectId ||
      invitation.acceptedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt <= at
    )
      return false;
    invitation.revokedAt = copy(at);
    return true;
  }

  async getPrompt(projectId: string): Promise<PromptRevisionRecord | null> {
    const project = this.projects.get(projectId);
    if (!project) return null;
    const revisions = this.promptRevisions.get(projectId) ?? [];
    const latest = revisions.find((revision) => revision.revision === project.promptRevision);
    if (latest) return copy(latest);
    return {
      id: 0,
      projectId,
      revision: project.promptRevision,
      prompt: project.currentPrompt,
      criteria: copy(project.criteria),
      editorId: null,
      createdAt: project.updatedAt,
    };
  }

  async listPromptRevisions(projectId: string): Promise<PromptRevisionRecord[]> {
    return (this.promptRevisions.get(projectId) ?? [])
      .slice()
      .sort((a, b) => b.revision - a.revision)
      .map(copy);
  }

  async updatePrompt(
    projectId: string,
    expectedRevision: number,
    prompt: string,
    criteria: Record<string, unknown>,
    editorId: number,
  ): Promise<{ project: ProjectRecord; revision: PromptRevisionRecord }> {
    const project = this.projects.get(projectId);
    if (!project) throw new HomingError("not_found", "Object not found.", 404);
    if (project.promptRevision !== expectedRevision)
      throw new HomingError("stale_write", "The prompt changed since it was read.", 409, {
        current_revision: project.promptRevision,
      });
    const now = new Date();
    project.currentPrompt = prompt;
    project.criteria = copy(criteria);
    project.promptRevision += 1;
    project.updatedAt = now;
    const revision: PromptRevisionRecord = {
      id: this.nextPromptId++,
      projectId,
      revision: project.promptRevision,
      prompt,
      criteria: copy(criteria),
      editorId,
      createdAt: now,
    };
    const revisions = this.promptRevisions.get(projectId) ?? [];
    revisions.push(revision);
    this.promptRevisions.set(projectId, revisions);
    return { project: copy(project), revision: copy(revision) };
  }

  async listLeads(
    projectId: string,
    options: LeadListOptions,
  ): Promise<{ items: LeadRecord[]; total: number; next?: string }> {
    const rows = [...this.leads.values()]
      .filter((lead) => lead.projectId === projectId && lead.status === options.status)
      .filter((lead) => {
        if (!options.query) return true;
        const query = options.query.toLowerCase();
        return [lead.title, lead.summary, lead.location].some((value) =>
          value.toLowerCase().includes(query),
        );
      })
      .filter(
        (lead) =>
          options.interestedUserId === undefined ||
          this.interests.has(this.interestKey(projectId, lead.id, options.interestedUserId)),
      )
      .filter((lead) => !options.interestedByAnyone || this.interestCount(projectId, lead.id) > 0)
      .sort((a, b) => {
        if (options.sort === "oldest")
          return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
        if (options.sort === "newest")
          return b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id);
        if (options.sort === "interest") {
          const aCount = this.interestCount(projectId, a.id);
          const bCount = this.interestCount(projectId, b.id);
          return (
            bCount - aCount ||
            b.updatedAt.getTime() - a.updatedAt.getTime() ||
            b.id.localeCompare(a.id)
          );
        }
        if (options.sort === "price_asc" || options.sort === "price_desc") {
          if (a.priceAmount === null) return 1;
          if (b.priceAmount === null) return -1;
          return options.sort === "price_asc"
            ? a.priceAmount - b.priceAmount || a.id.localeCompare(b.id)
            : b.priceAmount - a.priceAmount || b.id.localeCompare(a.id);
        }
        if (options.sort === "source_asc" || options.sort === "source_desc") {
          const compared = a.source.localeCompare(b.source);
          return (options.sort === "source_asc" ? compared : -compared) || a.id.localeCompare(b.id);
        }
        if (options.sort === "days_asc" || options.sort === "days_desc") {
          if (a.listedAt === null) return 1;
          if (b.listedAt === null) return -1;
          const compared = a.listedAt.localeCompare(b.listedAt);
          return (options.sort === "days_asc" ? -compared : compared) || a.id.localeCompare(b.id);
        }
        return b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id);
      });
    const total = rows.length;
    let start = 0;
    if (options.after) {
      const index = rows.findIndex((lead) => lead.id === options.after);
      start = index < 0 ? rows.length : index + 1;
    }
    const items = rows.slice(start, start + options.limit).map(copy);
    const hasNext = start + options.limit < rows.length;
    const last = items.at(-1);
    return { items, total, ...(hasNext && last ? { next: last.id } : {}) };
  }

  async getLead(projectId: string, leadId: string): Promise<LeadRecord | null> {
    const lead = this.leads.get(projectKey(projectId, leadId));
    return lead ? copy(lead) : null;
  }

  async createLead(lead: LeadRecord): Promise<LeadRecord> {
    const identity = identityKey(lead);
    const existing = [...this.leads.values()].find(
      (candidate) => candidate.projectId === lead.projectId && identityKey(candidate) === identity,
    );
    if (existing)
      throw new HomingError("conflict", "A lead with this identity already exists.", 409);
    this.leads.set(projectKey(lead.projectId, lead.id), copy(lead));
    return copy(lead);
  }

  async updateLead(
    projectId: string,
    leadId: string,
    expectedRevision: number,
    patch: Partial<LeadRecord>,
  ): Promise<LeadRecord> {
    const lead = this.leads.get(projectKey(projectId, leadId));
    if (lead?.status !== "active") throw new HomingError("not_found", "Object not found.", 404);
    if (lead.revision !== expectedRevision) {
      throw new HomingError("stale_write", "The lead changed since it was read.", 409, {
        current_revision: lead.revision,
      });
    }
    Object.assign(lead, copy(patch), { revision: lead.revision + 1, updatedAt: new Date() });
    return copy(lead);
  }

  async bulkUpsertLeads(
    projectId: string,
    actorId: number,
    items: LeadWrite[],
  ): Promise<BulkUpsertResult[]> {
    const results: BulkUpsertResult[] = [];
    for (const item of items) {
      const canonicalUrl = item.url;
      const identityHash = hash(normalizeListingUrl(canonicalUrl));
      const key = identityKey({
        source: item.source,
        sourceListingId: item.source_listing_id ?? "",
        identityHash,
        canonicalUrl,
      });
      const existing = [...this.leads.values()].find(
        (lead) => lead.projectId === projectId && identityKey(lead) === key,
      );
      const urlCollision = [...this.leads.values()].find(
        (lead) =>
          lead.projectId === projectId &&
          lead.identityHash === identityHash &&
          lead.id !== existing?.id,
      );
      const idCollision = item.id
        ? [...this.leads.values()].find((lead) => lead.id === item.id && lead.id !== existing?.id)
        : undefined;
      if (urlCollision || idCollision) {
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
          error: { code: "lead_trashed", message: "Trashed leads cannot be re-added." },
        });
        continue;
      }
      if (!existing) {
        const now = new Date();
        const lead: LeadRecord = {
          id: item.id ?? crypto.randomUUID(),
          projectId,
          source: item.source,
          sourceListingId: item.source_listing_id ?? "",
          canonicalUrl,
          identityHash,
          sourceUrl: item.source_url ?? "",
          title: item.title,
          summary: item.summary ?? "",
          location: item.location ?? "",
          priceDisplay: item.price_display ?? "",
          priceAmount: item.price_amount ?? null,
          priceCurrency: item.currency ?? "USD",
          availability: item.availability ?? "",
          housingType: item.housing_type ?? "unknown",
          dateConfidence: item.date_confidence ?? "unknown",
          listedAt: item.listed_at ?? null,
          parkNotes: item.parks ?? "",
          attributes: copy(item.attributes ?? {}),
          verificationNotes: item.verification_notes ?? "",
          status: "active",
          trashedById: null,
          trashedAt: null,
          creatorId: actorId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.leads.set(projectKey(projectId, lead.id), lead);
        results.push({ outcome: "created", lead: copy(lead) });
        continue;
      }
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
      if (item.if_match.replaceAll('"', "") !== String(existing.revision)) {
        results.push({
          outcome: "conflict",
          error: { code: "stale_write", message: "The lead changed since it was read." },
        });
        continue;
      }
      const before = JSON.stringify(existing);
      const patch: Partial<LeadRecord> = {
        source: item.source,
        sourceListingId: item.source_listing_id ?? existing.sourceListingId,
        canonicalUrl,
        identityHash,
        sourceUrl: item.source_url ?? existing.sourceUrl,
        title: item.title,
        summary: item.summary ?? existing.summary,
        location: item.location ?? existing.location,
        priceDisplay: item.price_display ?? existing.priceDisplay,
        priceAmount: item.price_amount ?? existing.priceAmount,
        priceCurrency: item.currency ?? existing.priceCurrency,
        availability: item.availability ?? existing.availability,
        housingType: item.housing_type ?? existing.housingType,
        dateConfidence: item.date_confidence ?? existing.dateConfidence,
        listedAt: item.listed_at === undefined ? existing.listedAt : item.listed_at,
        parkNotes: item.parks ?? existing.parkNotes,
        attributes: item.attributes ?? existing.attributes,
        verificationNotes: item.verification_notes ?? existing.verificationNotes,
      };
      Object.assign(existing, patch);
      if (before === JSON.stringify(existing))
        results.push({ outcome: "unchanged", lead: copy(existing) });
      else {
        existing.revision += 1;
        existing.updatedAt = new Date();
        results.push({ outcome: "updated", lead: copy(existing) });
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
    const lead = this.leads.get(projectKey(projectId, leadId));
    if (!lead) throw new HomingError("not_found", "Object not found.", 404);
    if (expectedRevision !== undefined && lead.revision !== expectedRevision) {
      throw new HomingError("stale_write", "The lead changed since it was read.", 409, {
        current_revision: lead.revision,
      });
    }
    lead.status = status;
    lead.trashedById = status === "trashed" ? actorId : null;
    lead.trashedAt = status === "trashed" ? new Date() : null;
    lead.revision += 1;
    lead.updatedAt = new Date();
    return copy(lead);
  }

  async permanentlyDeleteLead(projectId: string, leadId: string): Promise<void> {
    if (!this.leads.delete(projectKey(projectId, leadId))) {
      throw new HomingError("not_found", "Object not found.", 404);
    }
    for (const key of [...this.interests]) {
      if (key.startsWith(`${projectId}:${leadId}:`)) this.interests.delete(key);
    }
    for (const [id, comment] of this.comments) {
      if (comment.leadId === leadId) this.comments.delete(id);
    }
  }

  async getInterest(projectId: string, leadId: string, userId: number): Promise<boolean> {
    return this.interests.has(this.interestKey(projectId, leadId, userId));
  }

  async getLeadStats(projectId: string, leadId: string, userId: number): Promise<LeadStats> {
    const interestedMemberships = [...this.memberships.values()].filter(
      (membership) =>
        membership.projectId === projectId &&
        this.interests.has(this.interestKey(projectId, leadId, membership.userId)),
    );
    return {
      interested: interestedMemberships.some((membership) => membership.userId === userId),
      interestCount: interestedMemberships.length,
      interestedUsers: interestedMemberships.map(
        (membership) => membership.displayName || membership.email || "Member",
      ),
      commentCount: [...this.comments.values()].filter(
        (comment) => comment.leadId === leadId && !comment.deletedAt,
      ).length,
    };
  }

  async setInterest(
    projectId: string,
    leadId: string,
    userId: number,
    interested: boolean,
  ): Promise<boolean> {
    const lead = this.leads.get(projectKey(projectId, leadId));
    if (lead?.status !== "active") throw new HomingError("not_found", "Object not found.", 404);
    const key = this.interestKey(projectId, leadId, userId);
    if (interested) this.interests.add(key);
    else this.interests.delete(key);
    return interested;
  }

  async listComments(projectId: string, leadId: string): Promise<CommentRecord[]> {
    const lead = await this.getLead(projectId, leadId);
    if (!lead) return [];
    return [...this.comments.values()]
      .filter((comment) => comment.leadId === leadId && !comment.deletedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(copy);
  }

  async createComment(comment: CommentRecord): Promise<CommentRecord> {
    const value = { ...copy(comment), id: comment.id || this.nextCommentId++ };
    this.comments.set(value.id, value);
    return copy(value);
  }

  async updateComment(id: number, patch: Partial<CommentRecord>): Promise<CommentRecord> {
    const comment = this.comments.get(id);
    if (!comment) throw new HomingError("not_found", "Object not found.", 404);
    Object.assign(comment, copy(patch));
    return copy(comment);
  }

  async getComment(
    projectId: string,
    leadId: string,
    commentId: number,
  ): Promise<CommentRecord | null> {
    const comment = this.comments.get(commentId);
    return comment &&
      !comment.deletedAt &&
      comment.leadId === leadId &&
      (await this.getLead(projectId, leadId))
      ? copy(comment)
      : null;
  }

  async getIdempotency(
    userId: number,
    tokenId: string | null,
    endpoint: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const record = this.idempotency.get(this.idempotencyKey(userId, tokenId, endpoint, key));
    if (!record) return null;
    if (record.expiresAt <= new Date()) {
      this.idempotency.delete(this.idempotencyKey(userId, tokenId, endpoint, key));
      return null;
    }
    return copy(record);
  }

  async lockIdempotency(): Promise<void> {}

  async putIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord> {
    const value = copy(record);
    this.idempotency.set(
      this.idempotencyKey(record.userId, record.tokenId, record.endpoint, record.key),
      value,
    );
    return copy(value);
  }

  async recordMutation(): Promise<void> {}
}
