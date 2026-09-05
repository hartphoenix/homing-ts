import { expect, test } from "@playwright/test";

test("edits the production profile fields and manages connection history", async ({ page }) => {
  let profile = {
    display_name: "Hart",
    timezone: "America/New_York",
    bio: "Looking for a durable home base.",
    details: { accessibility: "Few stairs preferred" },
  };
  let savedProfile: Record<string, unknown> | undefined;
  let revokedTokenId = "";
  const tokens = [
    {
      id: "token-active",
      name: "Studio agent",
      prefix: "homing_studio",
      scopes: ["projects:read", "leads:read", "leads:write"],
      expires_at: "2035-11-20T13:00:00Z",
      revoked_at: null,
    },
    {
      id: "token-expired",
      name: "Old laptop",
      prefix: "homing_old",
      scopes: ["projects:read"],
      expires_at: "2020-07-01T13:00:00Z",
      revoked_at: null,
    },
    {
      id: "token-revoked",
      name: "Cloud test",
      prefix: "homing_cloud",
      scopes: ["projects:read"],
      expires_at: "2035-10-01T13:00:00Z",
      revoked_at: "2026-08-01T13:00:00Z",
    },
  ];
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: 1, email: "hart@example.test" },
        profile,
      }),
    });
  });
  await page.route("**/api/v1/me/profile", async (route) => {
    if (route.request().method() === "PATCH") {
      savedProfile = route.request().postDataJSON() as Record<string, unknown>;
      profile = { ...profile, ...savedProfile };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(profile) });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "test-csrf" }),
    });
  });
  await page.route("**/api/v1/auth/tokens/*", async (route) => {
    revokedTokenId = route.request().url().split("/").at(-1) ?? "";
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/auth/tokens", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: tokens }),
    });
  });

  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible();
  await expect(page.getByLabel("Display name")).toHaveValue("Hart");
  await expect(page.getByLabel("Timezone")).toHaveValue("America/New_York");
  await expect(page.getByLabel("Timezone").locator("optgroup").first()).toHaveAttribute(
    "label",
    "Detected from this browser",
  );
  await expect(page.getByLabel("Bio")).toHaveValue("Looking for a durable home base.");
  await expect(page.getByText("Few stairs preferred")).toHaveCount(0);
  await expect(page.getByLabel("Personal details")).toHaveCount(0);
  await expect(page.getByText("Agent activity", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Pause|Resume/ })).toHaveCount(0);

  await page.getByLabel("Display name").fill("Hart Phoenix");
  await page.getByLabel("Timezone").selectOption("Europe/Paris");
  await page.getByLabel("Bio").fill("Searching collaboratively.");
  await page.getByRole("button", { name: "Save profile" }).click();

  await expect.poll(() => savedProfile?.display_name).toBe("Hart Phoenix");
  expect(savedProfile?.timezone).toBe("Europe/Paris");
  expect(savedProfile).not.toHaveProperty("details");
  await expect(page.getByRole("status").filter({ hasText: "Profile saved." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Hart Phoenix" })).toHaveAttribute(
    "href",
    "/settings",
  );
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  const activeConnection = page.getByRole("listitem").filter({ hasText: "Studio agent" });
  const expiredConnection = page.getByRole("listitem").filter({ hasText: "Old laptop" });
  const revokedConnection = page.getByRole("listitem").filter({ hasText: "Cloud test" });
  await expect(activeConnection).toContainText("Active");
  await expect(expiredConnection).toContainText("Expired");
  await expect(revokedConnection).toContainText("Revoked");
  await expect(revokedConnection.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  await activeConnection.getByRole("button", { name: "Revoke" }).click();
  await expect.poll(() => revokedTokenId).toBe("token-active");
  await expect(activeConnection).toContainText("Revoked");
  await expect(activeConnection.getByRole("button", { name: "Revoke" })).toHaveCount(0);

  const previewToggle = page.getByRole("checkbox", { name: "Preview agent access history" });
  await previewToggle.check();
  await expect(page.getByRole("listitem").filter({ hasText: "Home computer" })).toBeVisible();
  await previewToggle.uncheck();
  await expect(page.getByRole("listitem").filter({ hasText: "Home computer" })).toHaveCount(0);
});
