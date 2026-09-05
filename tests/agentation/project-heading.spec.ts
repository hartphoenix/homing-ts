import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

test("aligns project glass containers within the shared content column", async ({ page }) => {
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
  const tabs = await page.locator(".project-tabs-row").boundingBox();

  expect(main).not.toBeNull();
  expect(header).not.toBeNull();
  expect(tabs).not.toBeNull();
  if (!main || !header || !tabs) return;

  expect(header.x).toBeCloseTo(main.x, 0);
  expect(tabs.x).toBeCloseTo(main.x, 0);
  expect(main.width).toBeCloseTo(700, 0);
  expect(header.width).toBeCloseTo(main.width, 0);
  expect(tabs.width).toBeCloseTo(main.width, 0);
  const title = await page.locator("header.page-heading h1").boundingBox();
  expect(title?.width).toBeCloseTo((header?.width ?? 0) - 34, 0);
  await expect(page.getByLabel("Search leads")).toHaveCSS(
    "background-color",
    "rgba(255, 253, 247, 0.75)",
  );
  await expect(page.getByLabel("Lead status")).toHaveCSS(
    "background-color",
    "rgba(255, 253, 247, 0.75)",
  );
});
