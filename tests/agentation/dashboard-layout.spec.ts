import { expect, test } from "@playwright/test";

test("places the new-search action beneath the project list", async ({ page }) => {
  await page.setViewportSize({ width: 1209, height: 724 });
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
  await page.route("**/api/v1/me/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Local housing search",
            slug: "local-housing-search",
            description: "",
            status: "active",
            role: "owner",
            prompt_revision: 1,
            updated_at: "2026-08-22T12:00:00Z",
          },
        ],
      }),
    });
  });
  await page.route("**/api/v1/projects/*/leads?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 8 }),
    });
  });

  await page.goto("/");

  const main = await page.locator("main.page").boundingBox();
  const grid = await page.locator(".project-grid").boundingBox();
  const button = await page.getByRole("button", { name: "New search" }).boundingBox();

  expect(main).not.toBeNull();
  expect(grid).not.toBeNull();
  expect(button).not.toBeNull();
  if (!main || !grid || !button) return;

  expect(button.x).toBeCloseTo(main.x + 4, 0);
  expect(button.y).toBeCloseTo(grid.y + grid.height + 24, 0);
  await expect(page.getByText("8 leads")).toBeVisible();
});
