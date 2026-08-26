import { expect, test } from "@playwright/test";

test("auditions and remembers sign-in backgrounds", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unauthorized", message: "Authentication required" } }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("radio", { name: "Leafy block" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Brownstone interior" })).toBeVisible();
  await expect(page.locator(".login-form")).toHaveCSS("backdrop-filter", /blur\(22px\)/);
  await expect(page.locator(".login-form")).toHaveCSS(
    "background-color",
    "rgba(255, 253, 247, 0.7)",
  );
  await expect(page.locator("body")).toHaveCSS("overscroll-behavior-y", "none");
  await expect
    .poll(() =>
      page.locator("body").evaluate((body) => getComputedStyle(body, "::before").position),
    )
    .toBe("fixed");
  await page.getByTitle("Golden stoop").click();
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((element) => element.style.getPropertyValue("--site-background-image")),
    )
    .toContain("exterior-golden-stoop.jpg");
  await page.reload();
  await expect(page.getByRole("radio", { name: "Golden stoop" })).toBeChecked();
});

test("shows the interior treatment throughout the authenticated shell", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await page.route("**/api/v1/me/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Local housing search",
            slug: "local-housing-search",
            description: "A quiet home near Prospect Park.",
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

  await expect(page.getByRole("radio", { name: "Brownstone interior" })).toBeChecked();
  await expect(page.locator(".project-card")).toHaveCSS("backdrop-filter", "none");
  await expect(page.locator(".project-card")).toHaveCSS("transform", "none");
  await expect(page.locator(".app-shell")).toHaveCSS("top", "auto");
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((element) => element.style.getPropertyValue("--site-background-image")),
    )
    .toContain("interior-brownstone.jpg");
});
