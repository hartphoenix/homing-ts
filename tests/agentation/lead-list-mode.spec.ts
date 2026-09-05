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
    interested: true,
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
    interested: false,
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
    interested: false,
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

  let interestBody: { interested: boolean } | undefined;
  let failNextInterest = false;
  await page.route(`**/api/v1/projects/${projectId}/leads/*/interest`, async (route) => {
    interestBody = route.request().postDataJSON() as { interested: boolean };
    if (failNextInterest) {
      failNextInterest = false;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Interest could not be updated." } }),
      });
      return;
    }
    const leadId = new URL(route.request().url()).pathname.split("/").at(-2);
    const lead = leads.find((item) => item.id === leadId);
    if (lead) {
      if (interestBody.interested && !lead.interested) lead.interest_count += 1;
      if (!interestBody.interested && lead.interested) lead.interest_count -= 1;
      lead.interested = interestBody.interested;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(interestBody) });
  });

  let batchBody: unknown;
  await page.route(`**/api/v1/projects/${projectId}/leads/batch`, async (route) => {
    batchBody = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });

  await page.goto(`/projects/${projectId}`);
  await expect(
    page.locator(".lead-card").first().locator(".lead-card-engagement > span:not(.sr-only)"),
  ).toHaveText(["2 ♥", "|", "4 comments"]);
  await page.getByRole("button", { name: "List" }).click();

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(page.locator(".lead-card")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "On market" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Source" })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Interest" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(4);
  await expect(table).toContainText("$3,200");
  await expect(table).not.toContainText("/ month");
  const parksideRow = page.getByRole("row").filter({ hasText: "Parkside one-bedroom" });
  await expect(parksideRow).toContainText(/\d+d/);
  await expect(parksideRow.getByRole("button", { name: /Remove interest/ })).toHaveText("2 ♥");
  const gardenRow = page.getByRole("row").filter({ hasText: "Garden studio" });
  await gardenRow.getByRole("button", { name: /Mark interested/ }).click();
  await expect.poll(() => interestBody).toEqual({ interested: true });
  await expect(gardenRow.getByRole("button", { name: /Remove interest/ })).toHaveText("1 ♥");
  failNextInterest = true;
  await parksideRow.getByRole("button", { name: /Remove interest/ }).click();
  await expect(page.getByText("Interest could not be updated.")).toBeVisible();

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
  await page.getByRole("button", { name: "On market" }).click();
  await expect(page.getByRole("row").last()).toContainText("Unlisted loft");
  await expect(page.getByRole("columnheader", { name: "On market" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );

  await page.getByRole("textbox", { name: "Search leads" }).fill("south-facing");
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("row").nth(1)).toContainText("Parkside one-bedroom");

  await page.getByRole("checkbox", { name: "Select Parkside one-bedroom" }).check();
  await page.setViewportSize({ width: 375, height: 800 });
  const batchLayout = await page
    .getByRole("toolbar", { name: "Batch actions" })
    .evaluate((bar) => ({
      pageWidth: bar.closest("main")?.scrollWidth,
      pageClientWidth: bar.closest("main")?.clientWidth,
      actionsVisible: Array.from(bar.querySelectorAll("button")).every((button) => {
        const box = button.getBoundingClientRect();
        return box.left >= 0 && box.right <= document.documentElement.clientWidth;
      }),
    }));
  expect(batchLayout.pageWidth).toBe(batchLayout.pageClientWidth);
  expect(batchLayout.actionsVisible).toBe(true);
  await page.getByRole("button", { name: "Interested", exact: true }).click();
  await expect
    .poll(() => batchBody)
    .toEqual({
      lead_ids: ["11111111-1111-4111-8111-111111111101"],
      action: "interested",
    });

  await page.getByLabel("Lead status").selectOption("trash");
  await expect(page.getByRole("button", { name: /interest/i })).toHaveCount(0);
});

test("lead pagination consumes next_cursor and resets when the URL filter changes", async ({
  page,
}) => {
  const firstPage = Array.from({ length: 50 }, (_, index) => ({
    id: `11111111-1111-4111-8111-111111111${String(index + 200).padStart(3, "0")}`,
    project_id: projectId,
    source: "Homing",
    url: `https://example.test/${index}`,
    title: `First page lead ${index + 1}`,
    summary: "A paginated listing.",
    location: "Brooklyn",
    price_display: "$2,500",
    listed_at: "2026-08-20",
    status: "active",
    revision: 1,
    interested: false,
    interest_count: 0,
    comment_count: 0,
    updated_at: "2026-08-22T12:00:00Z",
  }));
  const secondPage = {
    ...firstPage[0],
    id: "11111111-1111-4111-8111-111111111999",
    title: "Second page lead",
  };
  const cursors: string[] = [];
  await page.route("**/api/v1/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: 1, email: "hart@example.test" },
        profile: { display_name: "Hart", timezone: "UTC", bio: "", details: {} },
      }),
    });
  });
  await page.route("**/api/v1/me/source-plan-reviews**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });
  await page.route(`**/api/v1/projects/${projectId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: projectId,
        name: "Paginated search",
        slug: "paginated-search",
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
    const query = url.searchParams.get("q") ?? "";
    const cursor = url.searchParams.get("cursor") ?? "";
    cursors.push(cursor);
    const isCountRequest = url.searchParams.get("limit") === "1";
    if (isCountRequest) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: firstPage.slice(0, 1), total: 51 }),
      });
      return;
    }
    const items = query ? [secondPage] : cursor ? [secondPage] : firstPage;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        total: 51,
        ...(query || cursor ? {} : { next_cursor: "page-2" }),
      }),
    });
  });

  await page.goto(`/projects/${projectId}?view=list`);
  await expect(page.getByRole("row")).toHaveCount(51);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/cursor=page-2/);
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByText("Second page lead")).toBeVisible();
  await page.getByRole("textbox", { name: "Search leads" }).fill("second");
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.getByRole("row")).toHaveCount(2);
  expect(cursors.at(-1)).toBe("");
});
