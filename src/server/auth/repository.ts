import type {
  AgentLinkPollResult,
  AgentLinkRecord,
  AgentTokenRecord,
  AuthProfile,
  AuthUser,
  CreateAgentLinkInput,
  CreateSessionInput,
  CreateTokenInput,
  InvitationRecord,
  RegisteredInvitation,
  RegisterInvitedUserInput,
  SessionRecord,
} from "./types";

/**
 * The router deliberately knows no Drizzle query details. Production adapters should implement
 * replacement/consumption methods transactionally with row locks where marked below.
 */
export interface AuthRepository {
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findUserById(id: number): Promise<AuthUser | null>;
  findProfileByUserId(id: number): Promise<AuthProfile | null>;
  updateProfile(
    userId: number,
    patch: Partial<Omit<AuthProfile, "userId">>,
    now: Date,
  ): Promise<AuthProfile | null>;

  getSession(digest: string): Promise<SessionRecord | null>;
  createSession(input: CreateSessionInput): Promise<void>;
  /** Rotate the session and optionally rehash the password in one transaction. */
  completeLogin(
    oldDigest: string | null,
    input: CreateSessionInput,
    userId: number,
    passwordHash?: string,
  ): Promise<void>;
  deleteSession(digest: string): Promise<void>;
  updateSessionCsrf(digest: string, csrfDigest: string): Promise<boolean>;

  findPendingInvitation(digest: string, now: Date): Promise<InvitationRecord | null>;
  /** Revalidates the invitation and account uniqueness while creating both user and profile. */
  registerInvitedUser(input: RegisterInvitedUserInput): Promise<RegisteredInvitation | null>;
  /** Atomically validates, accepts, and creates the membership. Returns the project id. */
  acceptInvitation(digest: string, userId: number, now: Date): Promise<string | null>;

  /** All keys are already HMAC digests; implementations lock/update auth_throttles atomically. */
  consumeThrottle(
    keyDigests: string[],
    now: Date,
    limit: number,
    windowMs: number,
  ): Promise<{ blocked: boolean; retryAfter: number }>;
  resetThrottle(keyDigests: string[], now: Date): Promise<void>;

  getTokenByDigest(digest: string): Promise<AgentTokenRecord | null>;
  getTokenById(userId: number, id: string): Promise<AgentTokenRecord | null>;
  listTokens(userId: number): Promise<AgentTokenRecord[]>;
  createToken(input: CreateTokenInput): Promise<AgentTokenRecord>;
  revokeToken(userId: number, id: string, at: Date): Promise<boolean>;
  touchToken(id: string, at: Date): Promise<void>;

  /** Returns null when the short user code collides with another live request. */
  createAgentLink(input: CreateAgentLinkInput): Promise<AgentLinkRecord | null>;
  getAgentLinkByDigest(digest: string): Promise<AgentLinkRecord | null>;
  /** Atomically locks the device row, accounts for one poll, and applies expiry. */
  pollAgentLink(digest: string, now: Date, maxPolls: number): Promise<AgentLinkPollResult>;
  getPendingAgentLinkByCode(userCode: string, now: Date): Promise<AgentLinkRecord | null>;
  updateAgentLink(id: string, patch: Partial<AgentLinkRecord>): Promise<void>;
  /** Atomically lock an approved link, insert this token, and mark it consumed. */
  consumeApprovedAgentLink(
    linkId: string,
    userId: number,
    input: CreateTokenInput,
  ): Promise<AgentTokenRecord | null>;
  /** Must atomically decide the newest live link for a normalized user code. */
  decideAgentLink(
    userCode: string,
    userId: number,
    decision: "approved" | "denied",
    at: Date,
  ): Promise<boolean>;
}
