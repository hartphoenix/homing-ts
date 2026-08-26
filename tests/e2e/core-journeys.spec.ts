import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";

const databaseUrl = process.env.HOMING_TEST_DATABASE_URL;
const projectId = "11111111-1111-4111-8111-111111111111";
const leadId = "44444444-4444-4444-8444-444444444444";
const pbkdf2Fixture = "pbkdf2_sha256$260000$known-salt$VgacIdGkvu2udMuuojgq5qqZphxnf+nAQ/gA83qSwkI";
const sql = databaseUrl
  ? postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => undefined })
  : null;

test.skip(!databaseUrl, "Set HOMING_TEST_DATABASE_URL to run live browser journeys.");

test.beforeEach(async () => {
  if (!sql) return;
  await sql`truncate table users restart identity cascade`;
  await sql`
    insert into users (id, email, password_hash)
    values (1, 'one@example.test', ${pbkdf2Fixture})
  `;
  await sql`select setval(pg_get_serial_sequence('users', 'id'), 1)`;
  await sql`
    insert into profiles (user_id, display_name, timezone, bio)
    values (1, 'One', 'America/New_York', 'Browser test profile')
  `;
  await sql`
    insert into projects
      (id, name, slug, description, current_prompt, criteria, creator_id,
       prompt_revision, feed_epoch)
    values
      (${projectId}, 'September housing', 'september-housing', 'A shared housing search',
       'Find a calm two-bedroom', ${JSON.stringify({ city: "Brooklyn" })}::jsonb,
       1, 1, 'browsertestepoch')
  `;
  await sql`
    insert into prompt_revisions (project_id, revision, prompt, criteria, editor_id)
    values (${projectId}, 1, 'Find a calm two-bedroom',
            ${JSON.stringify({ city: "Brooklyn" })}::jsonb, 1)
  `;
  await sql`
    insert into project_memberships (project_id, user_id, role)
    values (${projectId}, 1, 'owner')
  `;
  await sql`
    insert into leads
      (id, project_id, source, source_listing_id, canonical_url, identity_hash, source_url,
       title, summary, location, price_display, availability, housing_type, date_confidence,
       creator_id)
    values
      (${leadId}, ${projectId}, 'browser-test', 'listing-1',
       'https://example.test/listing-1', ${"f".repeat(64)}, 'https://example.test/listing-1',
       'Sunny Prospect Heights apartment', 'Quiet block near the park.', 'Prospect Heights',
       '$3,200', 'September 1', 'entire', 'strong', 1)
  `;
});

test.afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill("one@example.test");
  await page.getByLabel("Password").fill("fixture password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Your shared searches" })).toBeVisible();
}

async function chooseListView(page: Page): Promise<void> {
  const desktopControl = page.locator(".view-toggle").getByRole("button", { name: "List" });
  if (await desktopControl.isVisible()) {
    await desktopControl.click();
    return;
  }
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("button", { name: "View as list" })
    .click();
}

async function followShellLink(page: Page, name: "Agent setup" | "Settings"): Promise<void> {
  const desktopLink = page.locator(".desktop-nav").getByRole("link", { name, exact: true });
  if (await desktopLink.isVisible()) {
    await desktopLink.click();
    return;
  }
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("link", { name, exact: true })
    .click();
}

test("lead search state and collaboration survive the full browser journey", async ({ page }) => {
  await signIn(page);
  let trashedCommentReads = 0;
  page.on("request", (request) => {
    if (request.url().includes(`/leads/${leadId}/comments`)) trashedCommentReads += 1;
  });
  await page.getByRole("link", { name: /September housing/ }).click();
  await expect(page.getByRole("heading", { name: "September housing" })).toBeVisible();

  await page.getByLabel("Search leads").fill("Prospect");
  await expect(page).toHaveURL(/q=Prospect/);
  await chooseListView(page);
  await expect(page).toHaveURL(/view=list/);
  await page.getByLabel("Lead status").selectOption("trash");
  await expect(page.getByRole("heading", { name: "Trash is empty" })).toBeVisible();
  await page.getByLabel("Lead status").selectOption("active");
  await expect(page.getByRole("link", { name: /Sunny Prospect Heights apartment/ })).toBeVisible();

  await page.getByRole("link", { name: /Sunny Prospect Heights apartment/ }).click();
  await page.getByRole("button", { name: "Mark interested" }).click();
  await expect(page.getByRole("button", { name: "Remove interest" })).toBeVisible();
  await page.getByPlaceholder("Add a note for everyone…").fill("Worth visiting this week.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByText("Worth visiting this week.")).toBeVisible();

  await page.getByRole("button", { name: "Edit lead" }).click();
  await page.getByLabel("Title").fill("Sunny Prospect Heights home");
  await page.getByRole("button", { name: "Save lead" }).click();
  await expect(page.getByRole("heading", { name: "Sunny Prospect Heights home" })).toBeVisible();
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.getByRole("heading", { name: "September housing" })).toBeVisible();
  await page.getByLabel("Lead status").selectOption("trash");
  trashedCommentReads = 0;
  await page.getByRole("link", { name: /Sunny Prospect Heights home/ }).click();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  expect(trashedCommentReads).toBe(0);
  await expect(page.getByRole("button", { name: "Edit lead" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByRole("button", { name: "Move to trash" })).toBeVisible();
});

test("conflicts preserve drafts and final-owner errors remain legible", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: /September housing/ }).click();
  await page.getByRole("link", { name: "Brief" }).click();
  const instructions = page.getByLabel("Instructions");
  await instructions.fill("A local draft that must survive.");
  if (!sql) throw new Error("PostgreSQL is required for this journey.");
  await sql`
    update projects set current_prompt = 'Concurrent update', prompt_revision = 2
     where id = ${projectId}
  `;
  await sql`
    insert into prompt_revisions (project_id, revision, prompt, criteria, editor_id)
    values (${projectId}, 2, 'Concurrent update', ${JSON.stringify({ city: "Queens" })}::jsonb, 1)
  `;
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByText(/Your draft is still here/)).toBeVisible();
  await expect(instructions).toHaveValue("A local draft that must survive.");

  await page.getByRole("link", { name: "People" }).click();
  await page.getByLabel("Role for One").selectOption("editor");
  await expect(page.getByRole("alert")).toContainText("at least one owner");
});

test("profile settings, source repair, manual tokens, and session expiry rehydrate", async ({
  page,
}) => {
  if (!sql) throw new Error("PostgreSQL is required for this journey.");
  await sql`
    insert into source_plan_reviews
      (project_id, user_id, status, observed_prompt_revision)
    values (${projectId}, 1, 'open', 1)
  `;
  await signIn(page);
  await expect(page.getByLabel("Source plan review")).toBeVisible();
  await followShellLink(page, "Settings");
  await expect(page.getByRole("heading", { name: /assistant needs to review/ })).toBeVisible();
  await page.getByText("See what it says").click();
  await expect(page.getByLabel("Server-authored repair prompt")).toHaveValue(/\/agent\//);
  await expect(page.getByRole("button", { name: "Resolve review" })).toHaveCount(0);
  await followShellLink(page, "Agent setup");
  await page.getByText("Pairing codes", { exact: true }).click();
  await page.getByLabel("Key name").fill("Browser fallback key");
  await page.getByRole("button", { name: "Create access key" }).click();
  await expect(page.getByLabel("New access key")).not.toHaveValue("");
  const widths = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport);
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("heading", { name: "Your agent is connected" })).toHaveCount(0);

  await sql`delete from sessions`;
  await followShellLink(page, "Settings");
  await page.getByLabel("Bio").fill("Session expiry check");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("heading", { name: "Sign in again" })).toBeVisible();
});
