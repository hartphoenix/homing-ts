import { expect, test } from "@playwright/test";

test("annotates a Homing element without a browser error", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "unauthorized", message: "Sign in required." } }),
    });
  });

  await page.goto("/");

  const heading = page.getByRole("heading", { name: "Find the next place together." });
  await expect(heading).toBeVisible();
  await page.getByTitle("Start feedback mode").click();
  await heading.click();

  await expect(page.locator("[data-annotation-popup]")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
