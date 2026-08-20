import type { AgentScope } from "./scopes";

export type AuthUser = {
  id: number;
  email: string;
  passwordHash: string;
  passwordResetRequired: boolean;
  isActive: boolean;
};

export type AuthProfile = {
  userId: number;
  displayName: string;
  timezone: string;
  bio: string;
  personalDetails: Record<string, unknown>;
  agentPausedUntil: Date | null;
};

export type SessionRecord = {
  digest: string;
  userId: number | null;
  csrfDigest: string;
  expiresAt: Date;
  lastSeenAt?: Date;
};

export type AgentTokenRecord = {
  id: string;
  userId: number;
  name: string;
  tokenPrefix: string;
  digest: string;
  scopes: AgentScope[];
  projectIds: string[];
  expectedCadenceMinutes: number | null;
  environmentNote: string;
  exposedToChat: boolean;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type AgentLinkStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export type AgentLinkRecord = {
  id: string;
  deviceCodeDigest: string;
  userCode: string;
  agentLabel: string;
  environmentNote: string;
  requestedCadenceMinutes: number | null;
  status: AgentLinkStatus;
  expiresAt: Date;
  intervalSeconds: number;
  pollCount: number;
  lastPolledAt: Date | null;
  approvedById: number | null;
  issuedTokenId: string | null;
  createdAt: Date;
};

export type AgentLinkPollOutcome =
  | "access_denied"
  | "slow_down"
  | "expired_token"
  | "authorization_pending"
  | "approved";

export type AgentLinkPollResult = {
  outcome: AgentLinkPollOutcome;
  link: AgentLinkRecord | null;
};

export type Principal = {
  kind: "session" | "agent";
  user: AuthUser;
  token: AgentTokenRecord | null;
  scopes: readonly AgentScope[];
  sessionDigest?: string;
};

export type CreateSessionInput = {
  digest: string;
  userId: number | null;
  csrfDigest: string;
  expiresAt: Date;
};

export type CreateTokenInput = Omit<AgentTokenRecord, "createdAt" | "lastUsedAt" | "revokedAt"> & {
  createdAt?: Date;
};

export type CreateAgentLinkInput = Omit<
  AgentLinkRecord,
  "id" | "createdAt" | "status" | "pollCount" | "lastPolledAt" | "approvedById" | "issuedTokenId"
>;

export type InvitationRecord = {
  id: string;
  projectId: string;
  email: string;
  role: "editor" | "viewer";
  projectName: string;
  inviterName: string;
  expiresAt: Date;
};

export type RegisterInvitedUserInput = {
  invitationDigest: string;
  email: string;
  displayName: string;
  passwordHash: string;
  now: Date;
};

export type RegisteredInvitation = {
  user: AuthUser;
  projectId: string;
};
