import { expect, type Page, test } from "@playwright/test";

async function mockSignedInUser(page: Page) {
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
}

test("reveals and copies the setup prompt when no access key exists", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockSignedInUser(page);
  await page.route("**/api/v1/auth/tokens", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.goto("/agent-setup");

  await expect(
    page.getByRole("heading", { name: "Give your agent a secure service entrance" }),
  ).toBeVisible();

  const pairingCodes = page.getByText("Pairing codes", { exact: true });
  await expect(pairingCodes).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pair an existing agent" })).not.toBeVisible();
  await pairingCodes.click();
  await expect(page.getByRole("heading", { name: "Pair an existing agent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create a manual access key" })).toBeVisible();

  const contentOrder = await page
    .locator(".panel.prose")
    .evaluate((panel) => Array.from(panel.children).map((child) => child.className));
  expect(contentOrder.slice(0, 2)).toEqual(["agent-service-entrance", "pairing-codes"]);

  const previewToggle = page.getByRole("checkbox", { name: "Preview active agent key" });
  await previewToggle.check();
  await expect(page.getByRole("heading", { name: "Your agent is connected" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Active agent access keys" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Example agent/ })).toContainText("homing_preview");
  await expect(page.getByRole("button", { name: "Copy setup prompt" })).toBeVisible();
  await previewToggle.uncheck();

  await page.getByRole("button", { name: "Show setup prompt" }).click();

  const prompt = page.getByLabel("Setup prompt for your agent");
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue(
    /Read http:\/\/127\.0\.0\.1:4174\/agent\/ and follow it exactly\./,
  );

  await page.getByRole("button", { name: "Copy setup prompt" }).click();
  await expect(page.getByRole("status")).toHaveText("Setup prompt copied.");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("/agent/");
});

test("lists and disconnects multiple active agent keys", async ({ page }) => {
  await mockSignedInUser(page);
  let tokens = [
    {
      id: "token-one",
      name: "Studio agent",
      prefix: "homing_studio",
      created_at: "2026-07-15T13:00:00Z",
      expires_at: "2026-10-13T13:00:00Z",
      last_used_at: "2026-08-22T16:05:00Z",
      revoked_at: null,
    },
    {
      id: "token-two",
      name: "Laptop agent",
      prefix: "homing_laptop",
      created_at: "2026-08-01T09:30:00Z",
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
    },
  ];
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "test-csrf" }),
    });
  });
  await page.route("**/api/v1/auth/tokens/*", async (route) => {
    const tokenId = route.request().url().split("/").at(-1);
    tokens = tokens.filter((token) => token.id !== tokenId);
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/v1/auth/tokens", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: tokens }),
    });
  });

  await page.goto("/agent-setup");

  await expect(page.locator(".connection-summary")).toBeVisible();

  const contentOrder = await page
    .locator(".panel.prose")
    .evaluate((panel) => Array.from(panel.children).map((child) => child.className));
  expect(contentOrder.slice(0, 3)).toEqual([
    "connection-summary",
    "additional-agent-setup",
    "pairing-codes",
  ]);
  await expect(page.getByText("Pairing codes", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pair an existing agent" })).not.toBeVisible();

  const table = page.getByRole("table", { name: "Active agent access keys" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Connection",
    "Activated",
    "Expires",
    "Last used",
    "Options",
  ]);
  await expect(table.getByRole("row", { name: /Studio agent/ })).toBeVisible();
  const laptopRow = table.getByRole("row", { name: /Laptop agent/ });
  await expect(laptopRow).toContainText("Does not expire");
  await expect(laptopRow).toContainText("Never");
  await expect(page.getByRole("button", { name: "Copy setup prompt" })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 800 });
  const tableOverflow = await page.locator(".agent-key-table-wrap").evaluate((wrapper) => ({
    clientWidth: wrapper.clientWidth,
    scrollWidth: wrapper.scrollWidth,
    panelWidth: wrapper.closest(".panel")?.scrollWidth,
    panelClientWidth: wrapper.closest(".panel")?.clientWidth,
  }));
  expect(tableOverflow.scrollWidth).toBeGreaterThan(tableOverflow.clientWidth);
  expect(tableOverflow.panelWidth).toBe(tableOverflow.panelClientWidth);

  await table
    .getByRole("row", { name: /Studio agent/ })
    .getByRole("button", {
      name: "Disconnect",
    })
    .click();
  await expect(table.getByRole("row", { name: /Studio agent/ })).toHaveCount(0);
  await expect(laptopRow).toBeVisible();
});
