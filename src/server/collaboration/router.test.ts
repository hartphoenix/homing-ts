import { describe, expect, it } from "vitest";

import { InMemoryCollaborationRepository } from "./memory-repository";
import { createCollaborationRouter } from "./router";
import type { CollaborationPrincipal, MembershipRecord, ProjectRecord } from "./types";

const projectId = "11111111-1111-4111-8111-111111111111";
const inviteId = "22222222-2222-4222-8222-222222222222";
const leadOne = "33333333-3333-4333-8333-333333333333";
const leadTwo = "44444444-4444-4444-8444-444444444444";
const fixedNow = new Date("2026-08-20T16:00:00.000Z");

function seededProject(): ProjectRecord {
  return {
    id: projectId,
    name: "September housing",
    slug: "september-housing-11111111",
    description: "",
    currentPrompt: "Find a place",
    criteria: { borough: "Brooklyn" },
    status: "active",
    creatorId: 1,
    promptRevision: 1,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

function member(
  userId: number,
  role: MembershipRecord["role"],
  email = `person${userId}@example.test`,
): MembershipRecord {
  return {
    projectId,
    userId,
    email,
    displayName: `Person ${userId}`,
    role,
    joinedAt: fixedNow,
  };
}

function harness(
  repository = new InMemoryCollaborationRepository(),
  initialPrincipal: CollaborationPrincipal = {
    userId: 1,
    email: "owner@example.test",
    authKind: "session",
  },
) {
  let principal = initialPrincipal;
  const ids = [projectId, inviteId];
  const app = createCollaborationRouter({
    repository,
    principal: () => principal,
    now: () => fixedNow,
    makeId: () => ids.shift() ?? crypto.randomUUID(),
  });
  return {
    app,
    repository,
    setPrincipal(value: CollaborationPrincipal) {
      principal = value;
    },
  };
}

function jsonRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://homing.test${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("collaboration routes", () => {
  it("creates a server-named project and lists it with the member role", async () => {
    const repository = new InMemoryCollaborationRepository();
    const { app } = harness(repository);

    const rejectedSlug = await app.request(
      jsonRequest("POST", "/projects", {
        name: "September Housing",
        slug: "chosen-by-client",
        prompt: "Find a place",
        criteria: {},
      }),
    );
    expect(rejectedSlug.status).toBe(422);

    const created = await app.request(
      jsonRequest("POST", "/projects", {
        name: "September Housing",
        description: "Shared search",
        prompt: "Find a place",
        criteria: { borough: "Brooklyn" },
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      id: projectId,
      slug: "september-housing-11111111",
      role: "owner",
      prompt_revision: 1,
    });

    const listed = await app.request("/me/projects");
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      items: [{ id: projectId, role: "owner" }],
    });
    expect(listedBody).not.toHaveProperty("agent_paused_until");
  });

  it("locks prompt revisions and returns the rejected draft", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner", "owner@example.test")],
    });
    const { app } = harness(repository);
    const updated = await app.request(
      jsonRequest(
        "PUT",
        `/projects/${projectId}/prompt`,
        {
          prompt: "Find a sunny place",
          criteria: { borough: "Brooklyn" },
          expected_revision: 1,
        },
        { "If-Match": '"1"' },
      ),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ revision: 2, prompt_revision: 2 });

    const draft = {
      prompt: "Keep this draft",
      criteria: { borough: "Queens" },
      expected_revision: 1,
    };
    const stale = await app.request(
      jsonRequest("PATCH", `/projects/${projectId}/prompt`, draft, { "If-Match": '"1"' }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale_write", fields: { draft } } });
  });

  it("serializes owner changes and prevents final-owner and self-removal failures", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner", "owner@example.test"), member(2, "viewer")],
    });
    const { app, setPrincipal } = harness(repository);

    const finalOwner = await app.request(
      jsonRequest("PATCH", `/projects/${projectId}/members/1`, { role: "editor" }),
    );
    expect(finalOwner.status).toBe(409);
    expect(await finalOwner.json()).toMatchObject({ error: { code: "final_owner" } });

    const selfRemoval = await app.request(
      jsonRequest("DELETE", `/projects/${projectId}/members/1`),
    );
    expect(selfRemoval.status).toBe(409);
    expect(await selfRemoval.json()).toMatchObject({ error: { code: "self_removal" } });

    const bodySelfRemoval = await app.request(
      jsonRequest("DELETE", `/projects/${projectId}/members`, { user_id: 1 }),
    );
    expect(bodySelfRemoval.status).toBe(409);
    expect(await bodySelfRemoval.json()).toMatchObject({ error: { code: "self_removal" } });

    setPrincipal({ userId: 2, email: "person2@example.test", authKind: "session" });
    const forbidden = await app.request(
      jsonRequest("PATCH", `/projects/${projectId}/members/1`, { role: "editor" }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("binds invitations to a normalized email and stores only the token digest", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner", "owner@example.test")],
    });
    const { app } = harness(repository);
    const created = await app.request(
      jsonRequest("POST", `/projects/${projectId}/invitations`, {
        email: "  NEW@Example.Test ",
        role: "editor",
      }),
    );
    expect(created.status).toBe(201);
    const invitation = (await created.json()) as { token: string };
    expect(invitation.token).toBeTruthy();

    const pending = await repository.listPendingInvitations(projectId, fixedNow);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.email).toBe("new@example.test");
    expect(pending[0]?.tokenDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(pending[0]?.tokenDigest).not.toBe(invitation.token);
  });

  it("lists active invitations and restricts creation/revocation to owners", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner", "owner@example.test"), member(2, "viewer")],
    });
    const { app, setPrincipal } = harness(repository);
    const created = await app.request(
      jsonRequest("POST", `/projects/${projectId}/invitations`, {
        email: "pending@example.test",
        role: "viewer",
      }),
    );
    expect(created.status).toBe(201);
    const invitation = (await created.json()) as { id: string };
    const members = await app.request(`/projects/${projectId}/members`);
    expect(await members.json()).toMatchObject({
      pending_invitations: [
        { id: invitation.id, email: "pending@example.test", role: "viewer", status: "pending" },
      ],
    });

    setPrincipal({ userId: 2, email: "person2@example.test", authKind: "session" });
    expect(
      (
        await app.request(
          jsonRequest("POST", `/projects/${projectId}/invitations`, {
            email: "second@example.test",
            role: "viewer",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          jsonRequest("DELETE", `/projects/${projectId}/invitations`, {
            invitation_id: invitation.id,
          }),
        )
      ).status,
    ).toBe(403);

    setPrincipal({ userId: 1, email: "owner@example.test", authKind: "session" });
    expect(
      (
        await app.request(
          jsonRequest("DELETE", `/projects/${projectId}/invitations`, {
            invitation_id: invitation.id,
          }),
        )
      ).status,
    ).toBe(204);
    expect(await (await app.request(`/projects/${projectId}/members`)).json()).toMatchObject({
      pending_invitations: [],
    });
  });

  it("isolates bulk item errors, reports indices, stats, and the browser trash path", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner", "owner@example.test")],
    });
    const { app, setPrincipal } = harness(repository);
    const body = {
      items: [
        {
          id: leadOne,
          source: "board",
          source_listing_id: "one",
          url: "https://EXAMPLE.test/one?utm_source=x",
          title: "Sunny room",
        },
        { source: "broken" },
        {
          id: leadTwo,
          source: "board",
          source_listing_id: "two",
          url: "https://example.test/two",
          title: "Garden flat",
        },
      ],
    };
    const created = await app.request(
      jsonRequest("POST", `/projects/${projectId}/leads/bulk-upsert`, body, {
        "Idempotency-Key": "bulk-one",
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      results: [
        { index: 0, outcome: "created", lead: { id: leadOne } },
        { index: 1, outcome: "error", error: { code: "validation_error" } },
        { index: 2, outcome: "created", lead: { id: leadTwo } },
      ],
    });

    const replay = await app.request(
      jsonRequest("POST", `/projects/${projectId}/leads/bulk-upsert`, body, {
        "Idempotency-Key": "bulk-one",
      }),
    );
    expect(await replay.json()).toEqual(createdBody);
    const changedKey = await app.request(
      jsonRequest(
        "POST",
        `/projects/${projectId}/leads/bulk-upsert`,
        { items: [{ ...body.items[0], title: "Changed" }] },
        { "Idempotency-Key": "bulk-one" },
      ),
    );
    expect(changedKey.status).toBe(409);

    expect(
      (await app.request(jsonRequest("PUT", `/projects/${projectId}/leads/${leadOne}/interest`)))
        .status,
    ).toBe(204);
    const detail = await app.request(`/projects/${projectId}/leads/${leadOne}`);
    expect(await detail.json()).toMatchObject({ interest_count: 1, is_interested: true });
    const interested = await app.request(
      `/projects/${projectId}/leads?q=Sunny&interest_scope=me&sort=interest&limit=1`,
    );
    expect(await interested.json()).toMatchObject({
      items: [{ id: leadOne, interest_count: 1 }],
      total: 1,
      next_cursor: null,
    });

    const trashed = await app.request(
      jsonRequest("DELETE", `/projects/${projectId}/leads/${leadOne}`),
    );
    expect(trashed.status).toBe(200);
    expect((await app.request(`/projects/${projectId}/leads/${leadOne}`)).status).toBe(200);
    const trash = await app.request(`/projects/${projectId}/trash?q=Sunny&sort=updated`);
    expect(await trash.json()).toMatchObject({ items: [{ id: leadOne, status: "trashed" }] });

    expect(
      (await app.request(jsonRequest("POST", `/projects/${projectId}/trash/${leadOne}/restore`)))
        .status,
    ).toBe(409);
    const restored = await app.request(
      jsonRequest("POST", `/projects/${projectId}/trash/${leadOne}/restore`, undefined, {
        "If-Match": trashed.headers.get("ETag") ?? "",
      }),
    );
    expect(restored.status).toBe(200);

    const staleDraft = { title: "My unsaved title", expected_revision: 2 };
    const stale = await app.request(
      jsonRequest("PATCH", `/projects/${projectId}/leads/${leadOne}`, staleDraft, {
        "If-Match": '"2"',
      }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { fields: { draft: staleDraft } } });

    setPrincipal({ userId: 2, email: "person2@example.test", authKind: "session" });
    await repository.upsertMembership(member(2, "viewer"));
    expect(
      (
        await app.request(
          jsonRequest("DELETE", `/projects/${projectId}/leads/${leadOne}/permanent`, undefined, {
            "If-Match": '"3"',
          }),
        )
      ).status,
    ).toBe(403);
    setPrincipal({ userId: 1, email: "owner@example.test", authKind: "session" });
    expect(
      (
        await app.request(
          jsonRequest("DELETE", `/projects/${projectId}/leads/${leadOne}/permanent`, undefined, {
            "If-Match": '"3"',
          }),
        )
      ).status,
    ).toBe(204);
  });

  it("keeps comment parents on one lead and lets authors soft-delete their own comments", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner", "owner@example.test")],
    });
    await repository.bulkUpsertLeads(projectId, 1, [
      {
        id: leadOne,
        source: "board",
        source_listing_id: "one",
        url: "https://example.test/one",
        title: "One",
      },
      {
        id: leadTwo,
        source: "board",
        source_listing_id: "two",
        url: "https://example.test/two",
        title: "Two",
      },
    ]);
    const { app } = harness(repository);
    const comment = await app.request(
      jsonRequest(
        "POST",
        `/projects/${projectId}/leads/${leadOne}/comments`,
        { body: "First" },
        { "Idempotency-Key": "comment-one" },
      ),
    );
    const created = (await comment.json()) as { id: number };
    expect(comment.status).toBe(201);

    const wrongParent = await app.request(
      jsonRequest("POST", `/projects/${projectId}/leads/${leadTwo}/comments`, {
        body: "Reply",
        parent_id: created.id,
      }),
    );
    expect(wrongParent.status).toBe(422);
    expect(
      (
        await app.request(
          jsonRequest("DELETE", `/projects/${projectId}/leads/${leadOne}/comments/${created.id}`),
        )
      ).status,
    ).toBe(204);
    expect(
      await (await app.request(`/projects/${projectId}/leads/${leadOne}/comments`)).json(),
    ).toEqual({ items: [] });
  });

  it("enforces bearer scopes and reserves human-only project administration", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner", "owner@example.test")],
    });
    const { app, setPrincipal } = harness(repository, {
      userId: 1,
      email: "owner@example.test",
      authKind: "bearer",
      scopes: ["projects:read"],
      projectIds: [projectId],
    });
    const project = await app.request(`/projects/${projectId}`);
    expect(project.status).toBe(200);
    expect(await project.json()).not.toMatchObject({
      prompt: expect.anything(),
      criteria: expect.anything(),
    });
    expect((await app.request(`/projects/${projectId}/prompt`)).status).toBe(403);
    expect(
      (
        await app.request(
          jsonRequest("POST", "/projects", { name: "No", prompt: "No", criteria: {} }),
        )
      ).status,
    ).toBe(403);

    setPrincipal({
      userId: 1,
      authKind: "bearer",
      scopes: ["projects:read"],
      projectIds: [inviteId],
    });
    expect((await app.request(`/projects/${projectId}`)).status).toBe(404);
  });

  it("does not leak interest or comment metadata through leads:read", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner", "owner@example.test")],
    });
    await repository.bulkUpsertLeads(projectId, 1, [
      {
        id: leadOne,
        source: "board",
        url: "https://example.test/one",
        title: "Private collaboration",
      },
    ]);
    await repository.setInterest(projectId, leadOne, 1, true);
    await repository.createComment({
      id: 0,
      leadId: leadOne,
      authorId: 1,
      parentId: null,
      body: "Private comment",
      createdAt: fixedNow,
      editedAt: null,
      deletedAt: null,
    });
    const { app, setPrincipal } = harness(repository, {
      userId: 1,
      authKind: "bearer",
      scopes: ["leads:read"],
      projectIds: [projectId],
    });

    const response = await app.request(`/projects/${projectId}/leads`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).not.toHaveProperty("interest_count");
    expect(body.items[0]).not.toHaveProperty("interested_users");
    expect(body.items[0]).not.toHaveProperty("comment_count");
    expect((await app.request(`/projects/${projectId}/leads?interest_scope=me`)).status).toBe(403);
    expect((await app.request(`/projects/${projectId}/leads?sort=interest`)).status).toBe(403);

    setPrincipal({
      userId: 1,
      authKind: "bearer",
      scopes: ["leads:write"],
      projectIds: [projectId],
    });
    const batchInterest = await app.request(
      jsonRequest("POST", `/projects/${projectId}/leads/batch`, {
        action: "uninterested",
        lead_ids: [leadOne],
      }),
    );
    expect(batchInterest.status).toBe(403);
    expect(await repository.getInterest(projectId, leadOne, 1)).toBe(true);

    setPrincipal({
      userId: 1,
      authKind: "bearer",
      scopes: ["leads:read", "interest:read", "comments:read"],
      projectIds: [projectId],
    });
    expect(await (await app.request(`/projects/${projectId}/leads`)).json()).toMatchObject({
      items: [{ interest_count: 1, interested_users: ["Person 1"], comment_count: 1 }],
    });
  });

  it("requires an active project under transactional authorization", async () => {
    const project = { ...seededProject(), status: "trashed" as const };
    const repository = new InMemoryCollaborationRepository({
      projects: [project],
      memberships: [member(1, "owner"), member(2, "editor")],
    });
    await expect(repository.assertMembership(projectId, 2)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(repository.assertOwner(projectId, 1)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(repository.assertOwner(projectId, 1, true)).resolves.toBeUndefined();
  });

  it("hides unrestricted memberships from project-restricted tokens", async () => {
    const secondProject = { ...seededProject(), id: inviteId, name: "Second search" };
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject(), secondProject],
      memberships: [member(1, "owner"), { ...member(1, "owner"), projectId: inviteId }],
    });
    const { app } = harness(repository, {
      userId: 1,
      authKind: "bearer",
      scopes: ["projects:read"],
      projectIds: [projectId],
    });
    const response = await app.request("/me/projects");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: projectId }] });
  });

  it("accepts the shipped client boundaries while refusing unsafe URL schemes", async () => {
    const repository = new InMemoryCollaborationRepository({
      projects: [seededProject()],
      memberships: [member(1, "owner")],
    });
    const { app } = harness(repository);
    const unsafe = await app.request(
      jsonRequest("POST", `/projects/${projectId}/leads/bulk-upsert`, {
        items: [{ source: "board", url: "javascript:alert(1)", title: "Unsafe" }],
      }),
    );
    expect(await unsafe.json()).toMatchObject({
      results: [{ outcome: "error", error: { code: "validation_error" } }],
    });

    const boundary = await app.request(
      jsonRequest("POST", `/projects/${projectId}/leads/bulk-upsert`, {
        items: [
          {
            id: leadOne,
            source: "board",
            source_listing_id: "s".repeat(300),
            url: "https://example.test/boundary",
            title: "Boundary",
            price_display: "p".repeat(200),
            price_amount: 1e100,
            currency: "$$$",
            housing_type: "co-op",
            observed_at: "2026-08-20T16:00:00",
          },
        ],
      }),
    );
    expect(boundary.status).toBe(200);
    expect(await boundary.json()).toMatchObject({ results: [{ outcome: "created" }] });
    expect(await repository.getLead(projectId, leadOne)).toMatchObject({
      sourceListingId: "s".repeat(300),
      priceDisplay: "p".repeat(200),
      priceAmount: null,
      priceCurrency: "USD",
      housingType: "unknown",
    });
  });
});
