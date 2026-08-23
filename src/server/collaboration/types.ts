import type { Context } from "hono";

export const roles = ["owner", "editor", "viewer"] as const;
export type Role = (typeof roles)[number];

export type CollaborationPrincipal = {
  userId: number;
  email?: string;
  /** Bearer tokens may narrow the projects and operations they can use. */
  projectIds?: readonly string[];
  scopes?: readonly string[];
  authKind?: "session" | "bearer";
  tokenId?: string;
};

export type CollaborationContext = Context & {
  get(name: "principal"): CollaborationPrincipal | undefined;
};

export type ProjectRecord = {
  id: string;
  name: string;
  slug: string;
  description: string;
  currentPrompt: string;
  criteria: Record<string, unknown>;
  status: "active" | "trashed";
  creatorId: number;
  promptRevision: number;
  updatedAt: Date;
  createdAt: Date;
};

export type PromptRevisionRecord = {
  id: number;
  projectId: string;
  revision: number;
  prompt: string;
  criteria: Record<string, unknown>;
  editorId: number | null;
  createdAt: Date;
};

export type MembershipRecord = {
  projectId: string;
  userId: number;
  email?: string;
  displayName?: string;
  role: Role;
  joinedAt: Date;
};

export type InvitationRecord = {
  id: string;
  projectId: string;
  email: string;
  role: Role;
  inviterId: number;
  tokenDigest: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type LeadStatus = "active" | "trashed";
export type HousingType = "entire" | "shared" | "unknown";
export type DateConfidence = "strong" | "verify" | "unknown";

export type LeadRecord = {
  id: string;
  projectId: string;
  source: string;
  sourceListingId: string;
  canonicalUrl: string;
  identityHash: string;
  sourceUrl: string;
  title: string;
  summary: string;
  location: string;
  priceDisplay: string;
  priceAmount: number | null;
  priceCurrency: string;
  availability: string;
  housingType: HousingType;
  dateConfidence: DateConfidence;
  listedAt: string | null;
  parkNotes: string;
  attributes: Record<string, unknown>;
  verificationNotes: string;
  status: LeadStatus;
  trashedById: number | null;
  trashedAt: Date | null;
  creatorId: number;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LeadWrite = {
  id?: string;
  source: string;
  source_listing_id?: string;
  url: string;
  identity_hash?: string;
  source_url?: string;
  title: string;
  summary?: string;
  location?: string;
  price_display?: string;
  price_amount?: number;
  currency?: string;
  availability?: string;
  housing_type?: HousingType;
  date_confidence?: DateConfidence;
  listed_at?: string | null;
  parks?: string;
  attributes?: Record<string, unknown>;
  verification_notes?: string;
  observed_at?: string;
  search_run_id?: string;
  if_match?: string;
};

export type LeadPatch = Partial<Omit<LeadWrite, "source" | "url" | "title">> & {
  source?: string;
  url?: string;
  title?: string;
  expected_revision?: number;
};

export type CommentRecord = {
  id: number;
  leadId: string;
  authorId: number;
  body: string;
  parentId: number | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
};

export type IdempotencyRecord = {
  userId: number;
  tokenId: string | null;
  endpoint: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  expiresAt: Date;
};

export type LeadListOptions = {
  status: LeadStatus;
  limit: number;
  after?: string;
  query?: string;
  interestedUserId?: number;
  interestedByAnyone?: boolean;
  sort?:
    | "updated"
    | "newest"
    | "oldest"
    | "interest"
    | "price_asc"
    | "price_desc"
    | "source_asc"
    | "source_desc"
    | "days_asc"
    | "days_desc";
};

export type LeadStats = {
  interested: boolean;
  interestCount: number;
  interestedUsers: string[];
  commentCount: number;
};

export type MutationActor = {
  userId: number;
  tokenId: string | null;
  actorKind: "user" | "agent";
  requestId: string;
};

/**
 * Storage is deliberately expressed in terms of domain records. The SQL
 * adapter can map these to Drizzle rows while focused tests use the provided
 * in-memory implementation. Every mutating operation is safe to invoke in a
 * repository transaction.
 */
export interface CollaborationRepository {
  transaction<T>(callback: (repository: CollaborationRepository) => Promise<T>): Promise<T>;

  listProjects(userId: number): Promise<ProjectRecord[]>;
  getAgentPausedUntil(userId: number): Promise<Date | null>;
  isUserActive(userId: number): Promise<boolean>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  createProject(input: Omit<ProjectRecord, "createdAt" | "updatedAt">): Promise<ProjectRecord>;
  updateProject(
    projectId: string,
    patch: Partial<Pick<ProjectRecord, "name" | "slug" | "description" | "status">>,
  ): Promise<ProjectRecord>;

  getMembership(projectId: string, userId: number): Promise<MembershipRecord | null>;
  listMemberships(projectId: string): Promise<MembershipRecord[]>;
  countOwners(projectId: string): Promise<number>;
  assertOwner(projectId: string, userId: number): Promise<void>;
  upsertMembership(membership: MembershipRecord): Promise<MembershipRecord>;
  removeMembership(projectId: string, userId: number): Promise<void>;
  changeMembershipRole(
    projectId: string,
    userId: number,
    role: Role,
    actorId: number,
  ): Promise<MembershipRecord>;
  removeMembershipSafely(projectId: string, userId: number, actorId: number): Promise<void>;
  createInvitation(invitation: InvitationRecord): Promise<InvitationRecord>;
  getInvitationByTokenDigest(tokenDigest: string): Promise<InvitationRecord | null>;
  updateInvitation(id: string, patch: Partial<InvitationRecord>): Promise<InvitationRecord>;

  getPrompt(projectId: string): Promise<PromptRevisionRecord | null>;
  listPromptRevisions(projectId: string): Promise<PromptRevisionRecord[]>;
  updatePrompt(
    projectId: string,
    expectedRevision: number,
    prompt: string,
    criteria: Record<string, unknown>,
    editorId: number,
  ): Promise<{ project: ProjectRecord; revision: PromptRevisionRecord }>;

  listLeads(
    projectId: string,
    options: LeadListOptions,
  ): Promise<{ items: LeadRecord[]; total: number; next?: string }>;
  getLead(projectId: string, leadId: string): Promise<LeadRecord | null>;
  createLead(lead: LeadRecord): Promise<LeadRecord>;
  updateLead(
    projectId: string,
    leadId: string,
    expectedRevision: number,
    patch: Partial<LeadRecord>,
  ): Promise<LeadRecord>;
  bulkUpsertLeads(
    projectId: string,
    actorId: number,
    items: LeadWrite[],
  ): Promise<BulkUpsertResult[]>;
  setLeadStatus(
    projectId: string,
    leadId: string,
    status: LeadStatus,
    actorId: number,
    expectedRevision?: number,
  ): Promise<LeadRecord>;
  permanentlyDeleteLead(projectId: string, leadId: string): Promise<void>;
  getInterest(projectId: string, leadId: string, userId: number): Promise<boolean>;
  getLeadStats(projectId: string, leadId: string, userId: number): Promise<LeadStats>;
  setInterest(
    projectId: string,
    leadId: string,
    userId: number,
    interested: boolean,
  ): Promise<boolean>;
  listComments(projectId: string, leadId: string): Promise<CommentRecord[]>;
  createComment(comment: CommentRecord): Promise<CommentRecord>;
  updateComment(id: number, patch: Partial<CommentRecord>): Promise<CommentRecord>;
  getComment(projectId: string, leadId: string, commentId: number): Promise<CommentRecord | null>;

  getIdempotency(
    userId: number,
    tokenId: string | null,
    endpoint: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
  lockIdempotency(
    userId: number,
    tokenId: string | null,
    endpoint: string,
    key: string,
  ): Promise<void>;
  putIdempotency(record: IdempotencyRecord): Promise<IdempotencyRecord>;

  recordMutation(
    projectId: string,
    eventType: string,
    objectType: string,
    objectId: string,
    payload: Record<string, unknown>,
    actor: MutationActor,
    options?: { tombstone?: boolean; audit?: boolean },
  ): Promise<void>;
}

export type BulkUpsertResult = {
  outcome: "created" | "updated" | "unchanged" | "conflict" | "error";
  lead?: LeadRecord;
  error?: { code: string; message: string };
};

export type CollaborationDependencies = {
  repository: CollaborationRepository;
  principal?: (
    context: Context,
  ) => CollaborationPrincipal | Promise<CollaborationPrincipal | undefined> | undefined;
  now?: () => Date;
  makeId?: () => string;
  hashIdempotency?: (value: unknown) => string;
};
