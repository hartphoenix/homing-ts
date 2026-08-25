import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { getDatabase } from "../db/client";
import {
  agentLinks,
  agentTokens,
  auditEvents,
  authThrottles,
  profiles,
  projectChanges,
  projectInvitations,
  projectMemberships,
  projects,
  sessions,
  users,
} from "../db/schema";
import type { AuthRepository } from "./repository";
import { AGENT_SCOPE_SET, type AgentScope } from "./scopes";
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

type Database = ReturnType<typeof getDatabase>;
type UserRow = typeof users.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type TokenRow = typeof agentTokens.$inferSelect;
type LinkRow = typeof agentLinks.$inferSelect;

function authUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    passwordResetRequired: row.passwordResetRequired,
    isActive: row.isActive,
  };
}

function authProfile(row: ProfileRow): AuthProfile {
  return {
    userId: row.userId,
    displayName: row.displayName,
    timezone: row.timezone,
    bio: row.bio,
    personalDetails: row.personalDetails,
    agentPausedUntil: row.agentPausedUntil,
  };
}

function sessionRecord(row: SessionRow): SessionRecord {
  return {
    digest: row.digest,
    userId: row.userId,
    csrfDigest: row.csrfDigest,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function scopes(value: string[]): AgentScope[] {
  return value.filter((scope): scope is AgentScope => AGENT_SCOPE_SET.has(scope));
}

function tokenRecord(row: TokenRow): AgentTokenRecord {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    digest: row.digest,
    scopes: scopes(row.scopes),
    projectIds: row.projectIds,
    expectedCadenceMinutes: row.expectedCadenceMinutes,
    environmentNote: row.environmentNote,
    exposedToChat: row.exposedToChat,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

function linkRecord(row: LinkRow): AgentLinkRecord {
  return {
    id: row.id,
    deviceCodeDigest: row.deviceCodeDigest,
    userCode: row.userCode,
    agentLabel: row.agentLabel,
    environmentNote: row.environmentNote,
    requestedCadenceMinutes: row.requestedCadenceMinutes,
    status: row.status,
    expiresAt: row.expiresAt,
    intervalSeconds: row.intervalSeconds,
    pollCount: row.pollCount,
    lastPolledAt: row.lastPolledAt,
    approvedById: row.approvedById,
    issuedTokenId: row.issuedTokenId,
    createdAt: row.createdAt,
  };
}

function tokenInsert(input: CreateTokenInput) {
  return {
    id: input.id,
    userId: input.userId,
    name: input.name,
    tokenPrefix: input.tokenPrefix,
    digest: input.digest,
    scopes: input.scopes,
    projectIds: input.projectIds,
    expectedCadenceMinutes: input.expectedCadenceMinutes,
    environmentNote: input.environmentNote,
    exposedToChat: input.exposedToChat,
    expiresAt: input.expiresAt,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}

export class DrizzleAuthRepository implements AuthRepository {
  constructor(private readonly db: Database = getDatabase()) {}

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return row ? authUser(row) : null;
  }

  async findUserById(id: number): Promise<AuthUser | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? authUser(row) : null;
  }

  async findProfileByUserId(id: number): Promise<AuthProfile | null> {
    const [row] = await this.db.select().from(profiles).where(eq(profiles.userId, id)).limit(1);
    return row ? authProfile(row) : null;
  }

  async updateProfile(
    userId: number,
    patch: Partial<Omit<AuthProfile, "userId">>,
    now: Date,
  ): Promise<AuthProfile | null> {
    const [row] = await this.db
      .update(profiles)
      .set({ ...patch, updatedAt: now })
      .where(eq(profiles.userId, userId))
      .returning();
    return row ? authProfile(row) : null;
  }

  async getSession(digest: string): Promise<SessionRecord | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.digest, digest)).limit(1);
    return row ? sessionRecord(row) : null;
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    await this.db.insert(sessions).values(input);
  }

  async completeLogin(
    oldDigest: string | null,
    input: CreateSessionInput,
    userId: number,
    passwordHash?: string,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      if (oldDigest) {
        const deleted = await transaction
          .delete(sessions)
          .where(eq(sessions.digest, oldDigest))
          .returning({ digest: sessions.digest });
        if (deleted.length !== 1) throw new Error("login session was already consumed");
      }
      if (passwordHash) {
        await transaction
          .update(users)
          .set({ passwordHash, updatedAt: new Date() })
          .where(eq(users.id, userId));
      }
      await transaction.insert(sessions).values(input);
    });
  }

  async deleteSession(digest: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.digest, digest));
  }

  async updateSessionCsrf(digest: string, csrfDigest: string): Promise<boolean> {
    const rows = await this.db
      .update(sessions)
      .set({ csrfDigest, lastSeenAt: new Date() })
      .where(eq(sessions.digest, digest))
      .returning({ digest: sessions.digest });
    return rows.length === 1;
  }

  async findPendingInvitation(digest: string, now: Date): Promise<InvitationRecord | null> {
    const [row] = await this.db
      .select({
        id: projectInvitations.id,
        projectId: projectInvitations.projectId,
        email: projectInvitations.email,
        role: projectInvitations.role,
        projectName: projects.name,
        inviterEmail: users.email,
        inviterName: profiles.displayName,
        expiresAt: projectInvitations.expiresAt,
      })
      .from(projectInvitations)
      .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
      .innerJoin(users, eq(users.id, projectInvitations.inviterId))
      .innerJoin(
        projectMemberships,
        and(
          eq(projectMemberships.projectId, projectInvitations.projectId),
          eq(projectMemberships.userId, projectInvitations.inviterId),
        ),
      )
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(
        and(
          eq(projectInvitations.tokenDigest, digest),
          gt(projectInvitations.expiresAt, now),
          isNull(projectInvitations.acceptedAt),
          isNull(projectInvitations.revokedAt),
          eq(users.isActive, true),
          eq(projects.status, "active"),
          eq(projectMemberships.role, "owner"),
        ),
      )
      .limit(1);
    if (!row || (row.role !== "editor" && row.role !== "viewer")) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      email: row.email.toLowerCase(),
      role: row.role,
      projectName: row.projectName,
      inviterName: row.inviterName || row.inviterEmail,
      expiresAt: row.expiresAt,
    };
  }

  async registerInvitedUser(input: RegisterInvitedUserInput): Promise<RegisteredInvitation | null> {
    return this.db.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({ projectId: projectInvitations.projectId })
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.tokenDigest, input.invitationDigest),
            gt(projectInvitations.expiresAt, input.now),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
          ),
        )
        .limit(1);
      if (!candidate) return null;
      const [lockedProject] = await transaction
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, candidate.projectId))
        .limit(1)
        .for("update");
      if (lockedProject?.status !== "active") return null;
      const [invitation] = await transaction
        .select()
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.tokenDigest, input.invitationDigest),
            gt(projectInvitations.expiresAt, input.now),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!invitation || invitation.email.toLowerCase() !== input.email) return null;
      if (invitation.role !== "editor" && invitation.role !== "viewer") return null;
      const [inviter] = await transaction
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .innerJoin(
          projectMemberships,
          and(
            eq(projectMemberships.userId, users.id),
            eq(projectMemberships.projectId, invitation.projectId),
            eq(projectMemberships.role, "owner"),
          ),
        )
        .where(eq(users.id, invitation.inviterId))
        .limit(1);
      if (!inviter?.isActive) return null;
      const [existing] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${input.email}`)
        .limit(1);
      if (existing) return null;
      const [created] = await transaction
        .insert(users)
        .values({ email: input.email, passwordHash: input.passwordHash })
        .onConflictDoNothing()
        .returning();
      if (!created) return null;
      await transaction
        .insert(profiles)
        .values({ userId: created.id, displayName: input.displayName });
      await transaction.insert(projectMemberships).values({
        projectId: invitation.projectId,
        userId: created.id,
        role: invitation.role,
      });
      await transaction
        .update(projectInvitations)
        .set({ acceptedAt: input.now })
        .where(eq(projectInvitations.id, invitation.id));
      const [project] = await transaction
        .update(projects)
        .set({
          latestChangeSequence: sql`${projects.latestChangeSequence} + 2`,
          updatedAt: input.now,
        })
        .where(eq(projects.id, invitation.projectId))
        .returning({ latestChangeSequence: projects.latestChangeSequence });
      if (!project) throw new Error("invitation project disappeared during registration");
      const firstSequence = project.latestChangeSequence - 1;
      await transaction.insert(projectChanges).values([
        {
          projectId: invitation.projectId,
          sequence: firstSequence,
          eventType: "membership.joined",
          objectType: "membership",
          objectId: String(created.id),
          payload: { user_id: String(created.id), role: invitation.role },
          actorId: created.id,
        },
        {
          projectId: invitation.projectId,
          sequence: firstSequence + 1,
          eventType: "invitation.accepted",
          objectType: "invitation",
          objectId: invitation.id,
          payload: { user_id: String(created.id) },
          actorId: created.id,
        },
      ]);
      await transaction.insert(auditEvents).values({
        projectId: invitation.projectId,
        action: "invitation.accepted",
        objectType: "invitation",
        objectId: invitation.id,
        actorKind: "user",
        actorId: created.id,
        summary: { user_id: String(created.id), registration: true },
      });
      return { user: authUser(created), projectId: invitation.projectId };
    });
  }

  async acceptInvitation(digest: string, userId: number, now: Date): Promise<string | null> {
    return this.db.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({ projectId: projectInvitations.projectId })
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.tokenDigest, digest),
            gt(projectInvitations.expiresAt, now),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
          ),
        )
        .limit(1);
      if (!candidate) return null;
      const [lockedProject] = await transaction
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, candidate.projectId))
        .limit(1)
        .for("update");
      if (lockedProject?.status !== "active") return null;
      const [invitation] = await transaction
        .select()
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.tokenDigest, digest),
            gt(projectInvitations.expiresAt, now),
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!invitation || (invitation.role !== "editor" && invitation.role !== "viewer")) {
        return null;
      }
      const [recipient] = await transaction
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (
        !recipient?.isActive ||
        recipient.email.toLowerCase() !== invitation.email.toLowerCase()
      ) {
        return null;
      }
      const [inviter] = await transaction
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .innerJoin(
          projectMemberships,
          and(
            eq(projectMemberships.userId, users.id),
            eq(projectMemberships.projectId, invitation.projectId),
            eq(projectMemberships.role, "owner"),
          ),
        )
        .where(eq(users.id, invitation.inviterId))
        .limit(1);
      if (!inviter?.isActive) return null;

      const joined = await transaction
        .insert(projectMemberships)
        .values({ projectId: invitation.projectId, userId, role: invitation.role })
        .onConflictDoNothing()
        .returning({ userId: projectMemberships.userId });
      await transaction
        .update(projectInvitations)
        .set({ acceptedAt: now })
        .where(eq(projectInvitations.id, invitation.id));

      const eventCount = joined.length ? 2 : 1;
      const [project] = await transaction
        .update(projects)
        .set({
          latestChangeSequence: sql`${projects.latestChangeSequence} + ${eventCount}`,
          updatedAt: now,
        })
        .where(eq(projects.id, invitation.projectId))
        .returning({ latestChangeSequence: projects.latestChangeSequence });
      if (!project) return null;
      const firstSequence = project.latestChangeSequence - eventCount + 1;
      if (joined.length) {
        await transaction.insert(projectChanges).values({
          projectId: invitation.projectId,
          sequence: firstSequence,
          eventType: "membership.joined",
          objectType: "membership",
          objectId: String(userId),
          payload: { user_id: String(userId), role: invitation.role },
          actorId: userId,
        });
      }
      await transaction.insert(projectChanges).values({
        projectId: invitation.projectId,
        sequence: firstSequence + (joined.length ? 1 : 0),
        eventType: "invitation.accepted",
        objectType: "invitation",
        objectId: invitation.id,
        payload: { user_id: String(userId) },
        actorId: userId,
      });
      await transaction.insert(auditEvents).values({
        projectId: invitation.projectId,
        action: "invitation.accepted",
        objectType: "invitation",
        objectId: invitation.id,
        actorKind: "user",
        actorId: userId,
        summary: { user_id: String(userId) },
      });
      return invitation.projectId;
    });
  }

  async consumeThrottle(
    keyDigests: string[],
    now: Date,
    limit: number,
    windowMs: number,
  ): Promise<{ blocked: boolean; retryAfter: number }> {
    return this.db.transaction(async (transaction) => {
      let blocked = false;
      let retryAfter = 0;
      for (const keyDigest of [...new Set(keyDigests)]) {
        await transaction
          .insert(authThrottles)
          .values({ keyDigest, failureCount: 0, windowStartedAt: now, updatedAt: now })
          .onConflictDoNothing();
        const [row] = await transaction
          .select()
          .from(authThrottles)
          .where(eq(authThrottles.keyDigest, keyDigest))
          .limit(1)
          .for("update");
        if (!row) throw new Error("authentication throttle row disappeared");
        const windowExpired = now.getTime() - row.windowStartedAt.getTime() >= windowMs;
        if (windowExpired) {
          await transaction
            .update(authThrottles)
            .set({
              failureCount: 1,
              windowStartedAt: now,
              blockedUntil: null,
              updatedAt: now,
            })
            .where(eq(authThrottles.keyDigest, keyDigest));
          continue;
        }
        if (row.blockedUntil && row.blockedUntil > now) {
          blocked = true;
          retryAfter = Math.max(
            retryAfter,
            Math.ceil((row.blockedUntil.getTime() - now.getTime()) / 1000),
          );
          continue;
        }
        const failureCount = row.failureCount + 1;
        const blockedUntil =
          failureCount > limit ? new Date(row.windowStartedAt.getTime() + windowMs) : null;
        await transaction
          .update(authThrottles)
          .set({ failureCount, blockedUntil, updatedAt: now })
          .where(eq(authThrottles.keyDigest, keyDigest));
        if (blockedUntil && blockedUntil > now) {
          blocked = true;
          retryAfter = Math.max(
            retryAfter,
            Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000),
          );
        }
      }
      return { blocked, retryAfter };
    });
  }

  async resetThrottle(keyDigests: string[], now: Date): Promise<void> {
    await this.db.transaction(async (transaction) => {
      for (const keyDigest of [...new Set(keyDigests)]) {
        await transaction
          .update(authThrottles)
          .set({ failureCount: 0, blockedUntil: null, windowStartedAt: now, updatedAt: now })
          .where(eq(authThrottles.keyDigest, keyDigest));
      }
    });
  }

  async getTokenByDigest(digest: string): Promise<AgentTokenRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.digest, digest))
      .limit(1);
    return row ? tokenRecord(row) : null;
  }

  async getTokenById(userId: number, id: string): Promise<AgentTokenRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentTokens)
      .where(and(eq(agentTokens.userId, userId), eq(agentTokens.id, id)))
      .limit(1);
    return row ? tokenRecord(row) : null;
  }

  async listTokens(userId: number): Promise<AgentTokenRecord[]> {
    const rows = await this.db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.userId, userId))
      .orderBy(desc(agentTokens.createdAt));
    return rows.map(tokenRecord);
  }

  async createToken(input: CreateTokenInput): Promise<AgentTokenRecord> {
    const [row] = await this.db.insert(agentTokens).values(tokenInsert(input)).returning();
    if (!row) throw new Error("token insert returned no row");
    return tokenRecord(row);
  }

  async revokeToken(userId: number, id: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(agentTokens)
      .set({ revokedAt: at })
      .where(and(eq(agentTokens.userId, userId), eq(agentTokens.id, id)))
      .returning({ id: agentTokens.id });
    return rows.length === 1;
  }

  async touchToken(id: string, at: Date): Promise<void> {
    await this.db.update(agentTokens).set({ lastUsedAt: at }).where(eq(agentTokens.id, id));
  }

  async createAgentLink(input: CreateAgentLinkInput): Promise<AgentLinkRecord | null> {
    return this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${input.userCode}))`);
      const [collision] = await transaction
        .select({ id: agentLinks.id })
        .from(agentLinks)
        .where(
          and(
            eq(agentLinks.userCode, input.userCode),
            eq(agentLinks.status, "pending"),
            gt(agentLinks.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (collision) return null;
      const [row] = await transaction
        .insert(agentLinks)
        .values({
          deviceCodeDigest: input.deviceCodeDigest,
          userCode: input.userCode,
          agentLabel: input.agentLabel,
          environmentNote: input.environmentNote,
          requestedCadenceMinutes: input.requestedCadenceMinutes,
          expiresAt: input.expiresAt,
          intervalSeconds: input.intervalSeconds,
        })
        .returning();
      if (!row) throw new Error("agent link insert returned no row");
      await transaction.insert(auditEvents).values({
        action: "agent_link.created",
        objectType: "agent_link",
        objectId: row.id,
        actorKind: "anonymous",
        summary: { agent_label: row.agentLabel },
      });
      return linkRecord(row);
    });
  }

  async getAgentLinkByDigest(digest: string): Promise<AgentLinkRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentLinks)
      .where(eq(agentLinks.deviceCodeDigest, digest))
      .limit(1);
    return row ? linkRecord(row) : null;
  }

  async pollAgentLink(digest: string, now: Date, maxPolls: number): Promise<AgentLinkPollResult> {
    return this.db.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(agentLinks)
        .where(eq(agentLinks.deviceCodeDigest, digest))
        .limit(1)
        .for("update");
      if (!row) return { outcome: "access_denied", link: null };
      if (row.status === "denied" || row.status === "consumed") {
        return { outcome: "access_denied", link: linkRecord(row) };
      }
      if (row.status === "expired") return { outcome: "expired_token", link: linkRecord(row) };

      const pollCount = row.pollCount + 1;
      const tooFast =
        row.lastPolledAt !== null &&
        now.getTime() - row.lastPolledAt.getTime() < row.intervalSeconds * 1_000;
      if (tooFast) {
        const [updated] = await transaction
          .update(agentLinks)
          .set({ pollCount, lastPolledAt: now })
          .where(eq(agentLinks.id, row.id))
          .returning();
        return { outcome: "slow_down", link: linkRecord(updated ?? row) };
      }

      if (row.expiresAt <= now || pollCount > maxPolls) {
        const [updated] = await transaction
          .update(agentLinks)
          .set({ status: "expired", pollCount, lastPolledAt: now })
          .where(eq(agentLinks.id, row.id))
          .returning();
        await transaction.insert(auditEvents).values({
          action: "agent_link.expired",
          objectType: "agent_link",
          objectId: row.id,
          actorKind: "system",
        });
        return { outcome: "expired_token", link: linkRecord(updated ?? row) };
      }

      const [updated] = await transaction
        .update(agentLinks)
        .set({ pollCount, lastPolledAt: now })
        .where(eq(agentLinks.id, row.id))
        .returning();
      const link = linkRecord(updated ?? row);
      return {
        outcome: link.status === "approved" ? "approved" : "authorization_pending",
        link,
      };
    });
  }

  async getPendingAgentLinkByCode(userCode: string, now: Date): Promise<AgentLinkRecord | null> {
    const [row] = await this.db
      .select()
      .from(agentLinks)
      .where(
        and(
          eq(agentLinks.userCode, userCode),
          eq(agentLinks.status, "pending"),
          gt(agentLinks.expiresAt, now),
        ),
      )
      .orderBy(desc(agentLinks.createdAt))
      .limit(1);
    return row ? linkRecord(row) : null;
  }

  async updateAgentLink(id: string, patch: Partial<AgentLinkRecord>): Promise<void> {
    const values: Partial<typeof agentLinks.$inferInsert> = {};
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.pollCount !== undefined) values.pollCount = patch.pollCount;
    if (patch.lastPolledAt !== undefined) values.lastPolledAt = patch.lastPolledAt;
    if (patch.approvedById !== undefined) values.approvedById = patch.approvedById;
    if (patch.issuedTokenId !== undefined) values.issuedTokenId = patch.issuedTokenId;
    if (Object.keys(values).length === 0) return;
    if (patch.status === "expired") {
      await this.db.transaction(async (transaction) => {
        await transaction.update(agentLinks).set(values).where(eq(agentLinks.id, id));
        await transaction.insert(auditEvents).values({
          action: "agent_link.expired",
          objectType: "agent_link",
          objectId: id,
          actorKind: "system",
        });
      });
      return;
    }
    await this.db.update(agentLinks).set(values).where(eq(agentLinks.id, id));
  }

  async consumeApprovedAgentLink(
    linkId: string,
    userId: number,
    input: CreateTokenInput,
  ): Promise<AgentTokenRecord | null> {
    return this.db.transaction(async (transaction) => {
      const [link] = await transaction
        .select()
        .from(agentLinks)
        .where(eq(agentLinks.id, linkId))
        .limit(1)
        .for("update");
      if (link?.status !== "approved" || link.approvedById !== userId) return null;
      const [token] = await transaction.insert(agentTokens).values(tokenInsert(input)).returning();
      if (!token) return null;
      await transaction
        .update(agentLinks)
        .set({ status: "consumed", issuedTokenId: token.id })
        .where(eq(agentLinks.id, link.id));
      await transaction.insert(auditEvents).values({
        action: "agent_link.consumed",
        objectType: "agent_link",
        objectId: link.id,
        actorKind: "user",
        actorId: userId,
        tokenId: token.id,
        summary: { token_id: token.id },
      });
      return tokenRecord(token);
    });
  }

  async decideAgentLink(
    userCode: string,
    userId: number,
    decision: "approved" | "denied",
    at: Date,
  ): Promise<boolean> {
    return this.db.transaction(async (transaction) => {
      const [link] = await transaction
        .select()
        .from(agentLinks)
        .where(
          and(
            eq(agentLinks.userCode, userCode),
            eq(agentLinks.status, "pending"),
            gt(agentLinks.expiresAt, at),
          ),
        )
        .orderBy(desc(agentLinks.createdAt))
        .limit(1)
        .for("update");
      if (!link) return false;
      await transaction
        .update(agentLinks)
        .set({ status: decision, approvedById: userId })
        .where(eq(agentLinks.id, link.id));
      await transaction.insert(auditEvents).values({
        action: `agent_link.${decision === "approved" ? "approved" : "denied"}`,
        objectType: "agent_link",
        objectId: link.id,
        actorKind: "user",
        actorId: userId,
        summary: { agent_label: link.agentLabel },
      });
      return true;
    });
  }
}
