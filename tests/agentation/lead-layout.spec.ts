import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";
const leadId = "44444444-4444-4444-8444-444444444444";

test("places price and conversation in the lead content column", async ({ page }) => {
  await page.setViewportSize({ width: 1470, height: 816 });
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
  await page.route(`**/api/v1/projects/${projectId}/leads/${leadId}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: leadId,
        project_id: projectId,
        source: "StreetEasy",
        url: "https://example.test/listing",
        title: "Sunny Prospect Heights apartment",
        summary: "A bright apartment near the park with enough room to work from home.",
        location: "Prospect Heights, Brooklyn",
        price_display: "$3,200",
        availability: "Available now",
        housing_type: "Apartment",
        date_confidence: "confirmed",
        status: "active",
        revision: 1,
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/leads/${leadId}/comments`, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) });
  });

  await page.goto(`/projects/${projectId}/leads/${leadId}`);

  await expect(page.getByRole("link", { name: "All Local housing search leads" })).toBeVisible();
  await expect(page.locator(".detail-heading .source")).toHaveCount(0);

  const main = await page.locator("main.detail-page").boundingBox();
  const back = await page.locator("main.detail-page > a.back").boundingBox();
  const detailHeading = await page.locator("header.detail-heading").boundingBox();
  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  const price = await page.locator(".detail-price").boundingBox();
  const listingLink = await page.getByRole("link", { name: "Open listing ↗" }).boundingBox();
  const article = await page.locator("article.panel").boundingBox();
  const conversation = await page.locator("aside.panel").boundingBox();

  expect(main).not.toBeNull();
  expect(back).not.toBeNull();
  expect(detailHeading).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(price).not.toBeNull();
  expect(listingLink).not.toBeNull();
  expect(article).not.toBeNull();
  expect(conversation).not.toBeNull();
  if (
    !main ||
    !back ||
    !detailHeading ||
    !heading ||
    !price ||
    !listingLink ||
    !article ||
    !conversation
  )
    return;

  expect(detailHeading.width).toBeCloseTo(main.width, 0);
  expect(heading.x).toBeGreaterThan(detailHeading.x);
  expect(heading.x + heading.width).toBeLessThan(detailHeading.x + detailHeading.width);
  expect(detailHeading.y - (back.y + back.height)).toBeLessThanOrEqual(32);
  expect(price.x).toBeGreaterThan(detailHeading.x);
  expect(price.y - (heading.y + heading.height)).toBeGreaterThanOrEqual(0);
  expect(price.y - (heading.y + heading.height)).toBeLessThanOrEqual(16);
  expect(listingLink.y + listingLink.height).toBeCloseTo(price.y + price.height, 0);
  expect(detailHeading.x + detailHeading.width - (listingLink.x + listingLink.width)).toBeCloseTo(
    17,
    0,
  );
  expect(article.y - (detailHeading.y + detailHeading.height)).toBeLessThanOrEqual(24);
  expect(conversation.x).toBeCloseTo(main.x, 0);
  expect(conversation.width).toBeCloseTo(main.width, 0);
  expect(conversation.y).toBeGreaterThan(article.y + article.height);
});

test("trash detail keeps forbidden actions hidden and restore refreshes the revision", async ({
  page,
}) => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const leadId = "44444444-4444-4444-8444-444444444444";
  let status: "trashed" | "active" = "active";
  let revision = 3;
  let editRevision: string | undefined;
  let commentsRequests = 0;
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
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "csrf" }),
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
  await page.route(`**/api/v1/projects/${projectId}/leads/${leadId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      editRevision = (await route.request().headerValue("if-match")) ?? undefined;
      revision += 1;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: leadId,
        project_id: projectId,
        source: "StreetEasy",
        url: "https://example.test/listing",
        title: "Sunny Prospect Heights apartment",
        summary: "A bright apartment.",
        location: "Prospect Heights, Brooklyn",
        price_display: "$3,200",
        availability: "Available now",
        housing_type: "Apartment",
        date_confidence: "confirmed",
        status,
        revision,
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/trash/${leadId}/restore`, async (route) => {
    status = "active";
    revision = 5;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: leadId,
        project_id: projectId,
        source: "StreetEasy",
        url: "https://example.test/listing",
        title: "Sunny Prospect Heights apartment",
        summary: "A bright apartment.",
        location: "Prospect Heights, Brooklyn",
        price_display: "$3,200",
        availability: "Available now",
        housing_type: "Apartment",
        date_confidence: "confirmed",
        status: "active",
        revision,
        updated_at: "2026-08-22T12:00:00Z",
      }),
    });
  });
  await page.route(`**/api/v1/projects/${projectId}/leads/${leadId}/comments`, async (route) => {
    commentsRequests += 1;
    if (status === "trashed") {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Comments are unavailable in trash." } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "cached-comment",
            author_id: 2,
            body: "Cached private note",
            created_at: "2026-08-22T12:00:00Z",
          },
        ],
      }),
    });
  });

  await page.goto(`/projects/${projectId}/leads/${leadId}`);
  await expect(page.getByText("Cached private note")).toBeVisible();
  await expect.poll(() => commentsRequests).toBe(1);
  status = "trashed";
  revision = 4;
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/projects/${projectId}/leads/${leadId}?from=trash`);
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit lead" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark interested" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(0);
  await expect(page.getByText("Cached private note")).toHaveCount(0);
  await expect.poll(() => commentsRequests).toBe(1);

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page).toHaveURL(`/projects/${projectId}/leads/${leadId}`);
  await expect(page.getByRole("button", { name: "Edit lead" })).toBeVisible();
  await page.getByRole("button", { name: "Edit lead" }).click();
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect.poll(() => editRevision).toBe('"5"');
});
