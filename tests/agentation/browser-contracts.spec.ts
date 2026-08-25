import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

test("invitation registration is bound to the invited email and consumes the token", async ({
  page,
}) => {
  let registration: Record<string, string> | undefined;
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({}) });
  });
  await page.route("**/api/v1/invitations/invite-token/accept", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          email: "new@example.test",
          role: "editor",
          project: { id: projectId, name: "Brooklyn search" },
          inviter_name: "Hart",
          expires_at: "2030-01-01T00:00:00Z",
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, body: JSON.stringify({ project_id: projectId }) });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "csrf" }),
    });
  });
  await page.route("**/api/v1/me/source-plan-reviews**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
  await page.route("**/api/v1/invitations/invite-token/register", async (route) => {
    registration = route.request().postDataJSON() as Record<string, string>;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "session-csrf", project_id: projectId, user: { id: 2 } }),
    });
  });

  await page.goto("/invitations/invite-token/accept");
  await expect(page.getByRole("heading", { name: "Brooklyn search" })).toBeVisible();
  await expect(page.getByLabel("Invited email")).toHaveValue("new@example.test");
  await expect(page.getByLabel("Invited email")).toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("link", { name: "Sign in to accept this invitation" }),
  ).toHaveAttribute("href", "/login?next=%2Finvitations%2Finvite-token%2Faccept");
  await page.getByLabel("Display name").fill("New member");
  await page.getByLabel("Password").fill("long-enough-test-password");
  await page.getByRole("button", { name: "Create account and join" }).click();
  await expect
    .poll(() => registration)
    .toMatchObject({
      email: "new@example.test",
      display_name: "New member",
    });
});

test("existing invitees can sign in without losing the invitation URL", async ({ page }) => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  let signedIn = false;
  let accepted = false;
  await page.route("**/api/v1/me", async (route) => {
    if (!signedIn) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: 2, email: "existing@example.test" },
        profile: { display_name: "Existing member", timezone: "UTC", bio: "", details: {} },
      }),
    });
  });
  await page.route("**/api/v1/invitations/existing-token/accept", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          email: "existing@example.test",
          role: "editor",
          project: { id: projectId, name: "Brooklyn search" },
          inviter_name: "Hart",
          expires_at: "2030-01-01T00:00:00Z",
        }),
      });
      return;
    }
    accepted = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ project_id: projectId }),
    });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "csrf" }),
    });
  });
  await page.route("**/api/v1/session", async (route) => {
    signedIn = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "session-csrf", user: { id: 2 } }),
    });
  });
  await page.route("**/api/v1/me/source-plan-reviews**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
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
        role: "editor",
        prompt_revision: 1,
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/leads?limit=1`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });

  await page.goto("/invitations/existing-token/accept");
  await page.getByRole("link", { name: "Sign in to accept this invitation" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Finvitations%2Fexisting-token%2Faccept/);
  await page.getByLabel("Email").fill("existing@example.test");
  await page.getByLabel("Password").fill("long-enough-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect.poll(() => accepted).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
});

test("pairing request shows agent context and records an explicit approval", async ({ page }) => {
  let action = "";
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: 1, email: "hart@example.test" },
        profile: {
          display_name: "Hart",
          timezone: "UTC",
          bio: "",
          details: {},
          agent_paused_until: null,
        },
      }),
    });
  });
  await page.route("**/api/v1/me/source-plan-reviews**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
  await page.route("**/api/v1/auth/agent-links/ABC123", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          user_code: "ABC123",
          agent_label: "Home agent",
          environment_note: "Runs on the household Mac.",
          requested_cadence_minutes: 60,
          expires_at: "2030-01-01T00:00:00Z",
        }),
      });
      return;
    }
    action = (route.request().postDataJSON() as { action: string }).action;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ status: action === "approve" ? "approved" : "denied" }),
    });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "csrf" }),
    });
  });

  await page.goto("/link/?code=ABC123");
  await expect(page.getByRole("heading", { name: "Connect Home agent?" })).toBeVisible();
  await expect(page.getByText("Runs on the household Mac.")).toBeVisible();
  await page.getByRole("button", { name: "Approve agent" }).click();
  await expect(page.getByRole("status")).toContainText("Pairing approved");
  expect(action).toBe("approve");
});

test("manual access keys include the complete non-destructive agent scope set", async ({
  page,
}) => {
  let requestBody: { name: string; scopes: string[] } | undefined;
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: 1, email: "hart@example.test" },
        profile: {
          display_name: "Hart",
          timezone: "UTC",
          bio: "",
          details: {},
          agent_paused_until: null,
        },
      }),
    });
  });
  await page.route("**/api/v1/me/source-plan-reviews**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
  await page.route("**/api/v1/auth/tokens", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { name: string; scopes: string[] };
      requestBody = body;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "token-1",
          token: "homing_test_token",
          scopes: body.scopes,
          project_ids: [],
          expires_at: "2030-01-01T00:00:00Z",
        }),
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "test-csrf-token" }),
    });
  });

  await page.goto("/agent-setup");
  await page.getByLabel("Key name").fill("Manual browser key");
  await page.getByRole("button", { name: "Create access key" }).click();
  await expect
    .poll(() => requestBody)
    .toMatchObject({
      name: "Manual browser key",
      scopes: [
        "profile:read",
        "projects:read",
        "prompts:read",
        "leads:read",
        "leads:write",
        "comments:read",
        "comments:write",
        "interest:read",
        "interest:write",
        "runs:write",
      ],
    });
});
