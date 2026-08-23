import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";

const leads = [
  {
    id: "11111111-1111-4111-8111-111111111101",
    project_id: projectId,
    source: "Zumper",
    url: "https://example.test/one",
    title: "Parkside one-bedroom",
    summary: "South-facing windows and laundry near Prospect Park.",
    location: "Park Slope, Brooklyn",
    price_display: "$3,200 / month",
    price_amount: 3200,
    listed_at: "2026-08-20",
    status: "active",
    revision: 1,
    interest_count: 2,
    comment_count: 4,
    updated_at: "2026-08-22T12:00:00Z",
  },
  {
    id: "11111111-1111-4111-8111-111111111102",
    project_id: projectId,
    source: "Craigslist",
    url: "https://example.test/two",
    title: "Garden studio",
    summary: "Private entrance and a shared backyard.",
    location: "Crown Heights, Brooklyn",
    price_display: "$2,250",
    price_amount: 2250,
    listed_at: "2026-08-18",
    status: "active",
    revision: 1,
    interest_count: 0,
    comment_count: 0,
    updated_at: "2026-08-21T12:00:00Z",
  },
  {
    id: "11111111-1111-4111-8111-111111111103",
    project_id: projectId,
    source: "StreetEasy",
    url: "https://example.test/three",
    title: "Unlisted loft",
    summary: "An airy loft with workspace.",
    location: "Bushwick, Brooklyn",
    price_display: "Price unknown",
    price_amount: null,
    listed_at: null,
    status: "active",
    revision: 1,
    interest_count: 0,
    comment_count: 1,
    updated_at: "2026-08-20T12:00:00Z",
  },
];

test("list mode is compact, sortable, searchable, and supports batch actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: 1, email: "hart@example.test" },
        profile: { display_name: "Hart", timezone: "America/New_York", bio: "", details: {} },
      }),
    });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "test" }),
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
    const url = new URL(route.request().url());
    let items = url.searchParams.get("limit") === "1" ? leads.slice(0, 1) : [...leads];
    const query = url.searchParams.get("q")?.toLowerCase();
    if (query) {
      items = items.filter((lead) =>
        [lead.title, lead.location, lead.summary].some((value) =>
          value.toLowerCase().includes(query),
        ),
      );
    }
    if (url.searchParams.get("sort") === "source_asc") {
      items.sort((a, b) => a.source.localeCompare(b.source));
    }
    if (url.searchParams.get("sort") === "price_asc") {
      items.sort((a, b) => {
        if (a.price_amount === null) return 1;
        if (b.price_amount === null) return -1;
        return a.price_amount - b.price_amount;
      });
    }
    if (url.searchParams.get("sort") === "days_asc") {
      items.sort((a, b) => {
        if (a.listed_at === null) return 1;
        if (b.listed_at === null) return -1;
        return b.listed_at.localeCompare(a.listed_at);
      });
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items, total: query ? items.length : leads.length }),
    });
  });

  let batchBody: unknown;
  await page.route(`**/api/v1/projects/${projectId}/leads/batch`, async (route) => {
    batchBody = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });

  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: "List" }).click();

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(page.locator(".lead-card")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Days on market" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(4);
  await expect(table).toContainText("$3,200");
  await expect(table).not.toContainText("/ month");

  const mainBox = await page.locator("main.project-page").boundingBox();
  const tableBox = await page.locator(".lead-table-wrap").boundingBox();
  expect(mainBox).not.toBeNull();
  expect(tableBox).not.toBeNull();
  if (mainBox && tableBox) {
    expect(tableBox.x).toBeCloseTo(mainBox.x, 0);
    expect(tableBox.width).toBeCloseTo(mainBox.width, 0);
  }
  await page.getByRole("button", { name: "Price" }).click();
  await expect(page.getByRole("row").nth(1)).toContainText("Garden studio");
  await page.getByRole("button", { name: "Source" }).click();
  await expect(page.getByRole("row").nth(1)).toContainText("Craigslist");
  await expect(page.getByRole("columnheader", { name: "Source" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await page.getByRole("button", { name: "Days on market" }).click();
  await expect(page.getByRole("row").last()).toContainText("Unlisted loft");
  await expect(page.getByRole("columnheader", { name: "Days on market" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );

  await page.getByRole("textbox", { name: "Search leads" }).fill("south-facing");
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("row").nth(1)).toContainText("Parkside one-bedroom");

  await page.getByRole("checkbox", { name: "Select Parkside one-bedroom" }).check();
  await page.getByRole("button", { name: "Interested", exact: true }).click();
  await expect
    .poll(() => batchBody)
    .toEqual({
      lead_ids: ["11111111-1111-4111-8111-111111111101"],
      action: "interested",
    });
});
