import { expect, test } from "@playwright/test";

test("edits the brief without exposing its structured JSON", async ({ page }) => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const criteria = { maximum_price: 3200, pets_allowed: true };
  let savedBody: Record<string, unknown> | undefined;
  let savedDescription: Record<string, unknown> | undefined;
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
      body: JSON.stringify({ csrf_token: "test-csrf" }),
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
  await page.route(`**/api/v1/projects/${projectId}/prompt`, async (route) => {
    savedBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });
  await page.route(`**/api/v1/projects/${projectId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      savedDescription = route.request().postDataJSON() as Record<string, unknown>;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: projectId,
        name: "Local housing search",
        slug: "local-housing-search",
        description: "Near Prospect Park.",
        status: "active",
        role: "owner",
        prompt_revision: 3,
        current_prompt: "Find a sunny apartment near Prospect Park.",
        criteria,
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });

  await page.goto(`/projects/${projectId}/brief`);

  await expect(page.getByRole("heading", { name: "What should the search find?" })).toBeVisible();
  await expect(page.getByText("Structured criteria")).toHaveCount(0);
  await expect(page.getByText("maximum_price")).toHaveCount(0);
  await page
    .getByLabel("Instructions")
    .fill("Keep this unsaved prompt draft while the project is refreshed.");
  await page
    .getByLabel("Description shown on the search card")
    .fill("Sunny homes near Prospect Park.");
  await page.getByRole("button", { name: "Save description" }).click();
  await expect.poll(() => savedDescription?.description).toBe("Sunny homes near Prospect Park.");
  await expect(page.getByLabel("Instructions")).toHaveValue(
    "Keep this unsaved prompt draft while the project is refreshed.",
  );
  await page.getByLabel("Instructions").fill("Find a quiet, sunny apartment near Prospect Park.");
  await page.getByRole("button", { name: "Save new revision" }).click();

  await expect
    .poll(() => savedBody?.prompt)
    .toBe("Find a quiet, sunny apartment near Prospect Park.");
  expect(savedBody?.criteria).toEqual(criteria);
});

test("session reauthentication keeps an unsaved brief draft mounted", async ({ page }) => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  let signedIn = false;
  let expireOnMe = false;
  let savedBody: Record<string, unknown> | undefined;
  await page.route("**/api/v1/me", async (route) => {
    if (expireOnMe && !signedIn) {
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
        user: { id: 1, email: "hart@example.test" },
        profile: { display_name: "Hart", timezone: "UTC", bio: "", details: {} },
      }),
    });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "test-csrf" }),
    });
  });
  await page.route("**/api/v1/me/source-plan-reviews**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
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
        name: "Local housing search",
        slug: "local-housing-search",
        description: "Near Prospect Park.",
        status: "active",
        role: "owner",
        prompt_revision: 3,
        current_prompt: "Find a sunny apartment near Prospect Park.",
        criteria: {},
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/prompt`, async (route) => {
    if (!signedIn) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }
    savedBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ prompt: savedBody.prompt, prompt_revision: 4 }),
    });
  });
  await page.route("**/api/v1/session", async (route) => {
    signedIn = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "session-csrf", user: { id: 1 } }),
    });
  });

  await page.goto(`/projects/${projectId}/brief`);
  const draft = "Keep this draft through the reauthentication interruption.";
  await page.getByLabel("Instructions").fill(draft);
  expireOnMe = true;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
  await expect(page.getByLabel("Instructions")).toHaveValue(draft);

  await page.getByLabel("Email").fill("hart@example.test");
  await page.getByLabel("Password").fill("long-enough-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in again" })).toHaveCount(0);
  await expect(page.getByLabel("Instructions")).toHaveValue(draft);
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect.poll(() => savedBody?.prompt).toBe(draft);
});

test("delayed reauth refreshes identity before revealing another account", async ({ page }) => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  let loginStarted = false;
  let userTwo = false;
  let releaseFreshMe: (() => void) | undefined;
  let freshMeReleased = false;
  await page.route("**/api/v1/me", async (route) => {
    if (loginStarted && !freshMeReleased) {
      await new Promise<void>((resolve) => {
        releaseFreshMe = resolve;
      });
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: userTwo
          ? { id: 2, email: "new@example.test" }
          : { id: 1, email: "hart@example.test" },
        profile: {
          display_name: userTwo ? "New account" : "Hart",
          timezone: "UTC",
          bio: "",
          details: {},
        },
      }),
    });
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
        name: userTwo ? "New account search" : "Old account search",
        slug: "account-search",
        description: "",
        status: "active",
        role: "owner",
        prompt_revision: 1,
        current_prompt: userTwo ? "New account prompt" : "Old account prompt",
        criteria: {},
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/prompt`, async (route) => {
    if (!userTwo) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });
  await page.route("**/api/v1/session", async (route) => {
    loginStarted = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "session-csrf", user: { id: 2 } }),
    });
  });

  await page.goto(`/projects/${projectId}/brief`);
  const draft = "Do not show this old-account draft to the new account.";
  await page.getByLabel("Instructions").fill(draft);
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();

  await page.getByLabel("Email").fill("new@example.test");
  await page.getByLabel("Password").fill("long-enough-test-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
  await expect(page.getByLabel("Instructions")).toHaveValue(draft);
  await expect.poll(() => releaseFreshMe).toBeDefined();

  userTwo = true;
  freshMeReleased = true;
  releaseFreshMe?.();
  await expect(page.getByRole("heading", { name: "Sign in again" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "New account search" })).toBeVisible();
  await expect(page.getByText("Old account search")).toHaveCount(0);
  await expect(page.getByLabel("Instructions")).toHaveValue("New account prompt");
});
