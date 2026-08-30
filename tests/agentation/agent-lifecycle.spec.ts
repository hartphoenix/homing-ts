import { expect, test } from "@playwright/test";

test("shows v2 lifecycle state and keeps pause, refresh, and removal claims factual", async ({
  page,
}) => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  let pausedUntil: string | null = null;
  let sourceAccessUntil: string | null = null;
  let refreshedConnection = "";
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
  await page.route("**/api/v1/auth/tokens", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "connection-v2",
            name: "Home agent",
            prefix: "homing_home",
            protocol_version: "v2",
            source_write_expires_at: sourceAccessUntil,
            expires_at: "2035-11-20T13:00:00Z",
            revoked_at: null,
          },
        ],
      }),
    });
  });
  await page.route("**/api/v1/agent/projects", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        paused_until: pausedUntil,
        projects: [
          {
            project_id: projectId,
            name: "Prospect Park homes",
            config_status: "ready",
            config_revision: 3,
            required_evidence: ["location", "price", "availability", "housing_type"],
            acquisition_basis: {
              locations: ["Brooklyn"],
              min_price_minor: 200000,
              max_price_minor: 320000,
              housing_types: ["entire"],
            },
            source_queries: [
              {
                id: "query-1",
                adapter: "streeteasy-com",
                status: "ready",
                query: { url: "https://streeteasy.com/for-rent/brooklyn" },
              },
            ],
            latest_run: {
              status: "incomplete",
              phase: "deliver",
              counts: {
                source_queries_total: 1,
                source_queries_attempted: 1,
                source_queries_completed: 1,
                candidates_observed: 4,
                candidates_evaluated: 4,
                candidates_kept: 1,
                candidates_insufficient: 0,
                deliveries_acknowledged: 0,
                deliveries_pending: 1,
              },
              failure: { phase: "deliver", code: "blocked_permission" },
            },
          },
          {
            project_id: "22222222-2222-4222-8222-222222222222",
            name: "Needs setup",
            config_status: "needed",
            latest_run: null,
          },
        ],
      }),
    });
  });
  await page.route("**/api/v1/csrf", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ csrf_token: "test-csrf" }),
    });
  });
  await page.route("**/api/v1/me/agent-pause", async (route) => {
    const body = route.request().postDataJSON() as { paused: boolean };
    pausedUntil = body.paused ? "2035-11-20T13:00:00Z" : null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ paused_until: pausedUntil }),
    });
  });
  await page.route("**/api/v1/auth/tokens/connection-v2/source-refresh", async (route) => {
    refreshedConnection = "connection-v2";
    sourceAccessUntil = "2035-11-20T13:15:00Z";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connection_id: refreshedConnection,
        scopes: ["agent-config:read", "source-config:write"],
        source_write_expires_at: sourceAccessUntil,
      }),
    });
  });

  await page.goto("/agent-setup");

  await expect(page.getByRole("heading", { name: "Agent lifecycle" })).toBeVisible();
  await expect(page.getByText("Configuration ready", { exact: true })).toBeVisible();
  await expect(page.getByText("Configuration needed", { exact: true })).toBeVisible();
  await expect(page.getByText("Locations: Brooklyn")).toBeVisible();
  await expect(page.getByText("Price: $2,000 to $3,200")).toBeVisible();
  await expect(
    page.getByText("streeteasy (https://streeteasy.com/for-rent/brooklyn)"),
  ).toBeVisible();
  await expect(page.getByText("Incomplete; work remains for a later run.")).toBeVisible();
  await expect(page.getByText("deliver: blocked_permission")).toBeVisible();
  await expect(page.getByText("connection-v2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow setup refresh" })).toBeVisible();
  await expect(
    page.getByText("Disconnect revokes this Homing connection only.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("It cannot remove files or the scheduled job on the Mac", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy removal command" })).toBeVisible();

  await page.getByRole("button", { name: "Pause agent for 14 days" }).click();
  await expect.poll(() => pausedUntil).not.toBeNull();
  await expect(page.getByRole("button", { name: "Resume agent" })).toBeVisible();
  await expect(page.getByText("Paused until", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Allow setup refresh" }).click();
  await expect.poll(() => refreshedConnection).toBe("connection-v2");
  await expect(page.getByText("Source setup access until", { exact: false })).toBeVisible();
});
