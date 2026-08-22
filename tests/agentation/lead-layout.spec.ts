import { expect, test } from "@playwright/test";

const projectId = "11111111-1111-4111-8111-111111111111";
const leadId = "44444444-4444-4444-8444-444444444444";

test("places price and conversation in the lead content column", async ({ page }) => {
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
  const detailHeading = await page.locator("header.detail-heading").boundingBox();
  const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
  const price = await page.locator(".detail-price").boundingBox();
  const listingLink = await page.getByRole("link", { name: "Open listing ↗" }).boundingBox();
  const article = await page.locator("article.panel").boundingBox();
  const conversation = await page.locator("aside.panel").boundingBox();

  expect(main).not.toBeNull();
  expect(detailHeading).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(price).not.toBeNull();
  expect(listingLink).not.toBeNull();
  expect(article).not.toBeNull();
  expect(conversation).not.toBeNull();
  if (!main || !detailHeading || !heading || !price || !listingLink || !article || !conversation)
    return;

  expect(detailHeading.width / main.width).toBeCloseTo(0.68, 2);
  expect(heading.width).toBeCloseTo(detailHeading.width, 0);
  expect(price.x).toBeCloseTo(main.x, 0);
  expect(price.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
  expect(listingLink.y + listingLink.height).toBeCloseTo(price.y + price.height, 0);
  expect(listingLink.x + listingLink.width).toBeCloseTo(detailHeading.x + detailHeading.width, 0);
  expect(conversation.x).toBeCloseTo(main.x, 0);
  expect(conversation.width / main.width).toBeCloseTo(0.68, 2);
  expect(conversation.y).toBeGreaterThan(article.y + article.height);
});
