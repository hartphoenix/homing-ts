import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

test("moves navigation and the inverse view action into a mobile menu", async ({ page }) => {
  await page.setViewportSize({ width: 580, height: 800 });
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
        updated_at: "2026-08-23T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/leads?**`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });

  await page.goto(`/projects/${projectId}`);

  await expect(page.locator(".desktop-nav")).toBeHidden();
  await expect(page.locator(".project-tabs-row .view-toggle")).toBeHidden();
  const menuTrigger = page.getByRole("button", { name: "Open navigation menu" });
  await expect(menuTrigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(menuTrigger).toHaveCSS("border-top-width", "0px");
  const triggerBox = await menuTrigger.boundingBox();
  expect(triggerBox?.width).toBeGreaterThanOrEqual(44);
  expect(triggerBox?.height).toBeGreaterThanOrEqual(44);
  await menuTrigger.click();
  const menu = page.getByRole("navigation", { name: "Mobile navigation" });
  const searchesLink = menu.getByRole("link", { name: "Searches" });
  const agentSetupLink = menu.getByRole("link", { name: "Agent setup" });
  const settingsLink = menu.getByRole("link", { name: "Settings" });
  await expect(searchesLink).toBeVisible();
  await expect(agentSetupLink).toBeVisible();
  await expect(settingsLink).toBeVisible();
  const [searchesBox, agentSetupBox, settingsBox] = await Promise.all([
    searchesLink.boundingBox(),
    agentSetupLink.boundingBox(),
    settingsLink.boundingBox(),
  ]);
  expect(searchesBox?.y).toBeLessThan(agentSetupBox?.y ?? 0);
  expect(agentSetupBox?.y).toBeLessThan(settingsBox?.y ?? 0);
  await menu.getByRole("button", { name: "View as list" }).click();
  await expect(page).toHaveURL(new RegExp(`projects/${projectId}\\?view=list$`));
  await expect(menu).toHaveCount(0);

  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await page.getByRole("button", { name: "View as cards" }).click();
  await expect(page).toHaveURL(new RegExp(`projects/${projectId}$`));

  await page.setViewportSize({ width: 581, height: 800 });
  await expect(page.locator(".desktop-nav")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeHidden();
});
