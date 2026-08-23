import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

test("positions the project heading beneath the topbar at full heading width", async ({ page }) => {
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
  await page.route(`**/api/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: projectId,
        name: "Local housing search",
        slug: "local-housing-search",
        description: "",
        status: "active",
        role: "owner",
        prompt_revision: 1,
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/leads?**`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.goto(`/projects/${projectId}`);

  const main = await page.locator("main.project-page").boundingBox();
  const header = await page.locator("header.page-heading").boundingBox();
  const heading = await page.getByRole("heading", { name: "Local housing search" }).boundingBox();

  expect(main).not.toBeNull();
  expect(header).not.toBeNull();
  expect(heading).not.toBeNull();
  if (!main || !header || !heading) return;

  expect(header.x).toBeCloseTo(main.x, 0);
  expect(header.y).toBeCloseTo(90, 0);
  expect(header.width).toBeCloseTo(928, 0);
  expect(heading.width).toBeCloseTo(header.width, 0);
});
