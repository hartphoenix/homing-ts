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
    .getByLabel("Description shown on the search card")
    .fill("Sunny homes near Prospect Park.");
  await page.getByRole("button", { name: "Save description" }).click();
  await expect.poll(() => savedDescription?.description).toBe("Sunny homes near Prospect Park.");
  await page.getByLabel("Instructions").fill("Find a quiet, sunny apartment near Prospect Park.");
  await page.getByRole("button", { name: "Save new revision" }).click();

  await expect
    .poll(() => savedBody?.prompt)
    .toBe("Find a quiet, sunny apartment near Prospect Park.");
  expect(savedBody?.criteria).toEqual(criteria);
});
