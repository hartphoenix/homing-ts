import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

test("invites, renders pending rows, and gives owners removal controls", async ({ page }) => {
  let projectRole = "owner";
  let memberItems = [
    { user_id: 1, display_name: "Hart", email: "hart@example.test", role: "owner" },
    { user_id: 2, display_name: "Mira", email: "mira@example.test", role: "viewer" },
  ];
  let pendingInvitations: Array<{
    id: string;
    email: string;
    role: string;
    status: "pending";
    expires_at: string;
  }> = [];
  let removedMemberId: number | undefined;
  let revokedInvitationId: string | undefined;

  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: 1, email: "hart@example.test" },
        profile: {
          display_name: "Hart",
          timezone: "America/New_York",
          bio: "",
          details: {},
          agent_paused_until: null,
        },
      }),
    });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "test-csrf-token" }),
    });
  });
  await page.route("**/api/v1/me/source-plan-reviews**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/leads?limit=1`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: projectId,
        name: "Brooklyn search",
        slug: "brooklyn-search",
        description: "",
        status: "active",
        role: projectRole,
        prompt_revision: 1,
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/members`, async (route) => {
    if (route.request().method() === "DELETE") {
      const body = route.request().postDataJSON() as { user_id: number };
      removedMemberId = body.user_id;
      memberItems = memberItems.filter((member) => member.user_id !== body.user_id);
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: memberItems, pending_invitations: pendingInvitations }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/invitations`, async (route) => {
    if (route.request().method() === "DELETE") {
      const body = route.request().postDataJSON() as { invitation_id: string };
      revokedInvitationId = body.invitation_id;
      pendingInvitations = pendingInvitations.filter(
        (invitation) => invitation.id !== body.invitation_id,
      );
      await route.fulfill({ status: 204 });
      return;
    }
    const body = route.request().postDataJSON() as { email: string; role: string };
    const invitation = {
      id: "invite-1",
      email: body.email,
      role: body.role,
      status: "pending" as const,
      expires_at: "2026-08-29T12:00:00Z",
      invite_url: "/invitations/one-time-token/accept",
    };
    pendingInvitations.push(invitation);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(invitation),
    });
  });

  await page.goto(`/projects/${projectId}/members`);

  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByLabel("Email address").fill("new-member@example.test");
  await page.getByRole("button", { name: "Create invite link" }).click();

  await expect(page.getByLabel("Invitation link")).toHaveValue(
    "http://127.0.0.1:4174/invitations/one-time-token/accept",
  );
  await expect(page.getByLabel("Invitation link")).toHaveAttribute("readonly", "");

  const pendingRow = page.locator(".member-row").filter({ hasText: "new-member@example.test" });
  await expect(pendingRow).toContainText("Pending");
  await expect(pendingRow).not.toContainText("one-time-token");
  await expect(page.getByRole("button", { name: "Invite" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(2);
  await expect(
    page.locator(".member-row").filter({ hasText: "hart@example.test" }).getByRole("button"),
  ).toHaveCount(0);

  await pendingRow.getByRole("button", { name: "Remove" }).click();
  await expect(pendingRow).toHaveCount(0);
  expect(revokedInvitationId).toBe("invite-1");

  const memberRow = page.locator(".member-row").filter({ hasText: "mira@example.test" });
  await memberRow.getByRole("button", { name: "Remove" }).click();
  await expect(memberRow).toHaveCount(0);
  expect(removedMemberId).toBe(2);

  projectRole = "viewer";
  await page.reload();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
});
