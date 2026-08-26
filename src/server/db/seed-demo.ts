import { and, eq, isNull, sql } from "drizzle-orm";

import { hashPassword } from "../auth/password";
import { getDatabase } from "./client";
import {
  leadComments,
  leadInterests,
  leads,
  profiles,
  projectMemberships,
  projects,
  users,
} from "./schema";

const DEMO_LEADS = [
  {
    source: "StreetEasy",
    title: "Sunlit brownstone near Prospect Park",
    location: "Park Slope, Brooklyn, NY",
    priceDisplay: "$3,450 / month",
    priceAmount: "3450.00",
    availability: "Available September 1",
    housingType: "entire" as const,
    dateConfidence: "strong" as const,
    summary: "Top-floor one-bedroom with south-facing windows and in-unit laundry.",
    parkNotes: "Prospect Park is three blocks away.",
    attributes: { bedrooms: 1, bathrooms: 1, pets: "cats allowed", laundry: "in unit" },
  },
  {
    source: "Craigslist",
    title: "Garden studio with flexible lease",
    location: "Crown Heights, Brooklyn, NY",
    priceDisplay: "$2,250 / month",
    priceAmount: "2250.00",
    availability: "Available now · 6–12 months",
    housingType: "entire" as const,
    dateConfidence: "verify" as const,
    summary: "Compact garden-level studio with a private entrance and shared backyard.",
    parkNotes: "Near Brower Park and the Brooklyn Botanic Garden.",
    attributes: { bedrooms: 0, outdoor_space: "shared yard", lease: "flexible" },
  },
  {
    source: "SpareRoom",
    title: "Room in a quiet two-bedroom",
    location: "Astoria, Queens, NY",
    priceDisplay: "$1,475 / month",
    priceAmount: "1475.00",
    availability: "October 1",
    housingType: "shared" as const,
    dateConfidence: "strong" as const,
    summary: "Furnished room with one housemate, elevator access, and utilities included.",
    parkNotes: "Twenty-minute walk to Astoria Park.",
    attributes: { furnished: true, roommates: 1, utilities_included: true, elevator: true },
  },
  {
    source: "Listings Project",
    title: "Loft with workspace and roof access",
    location: "Bushwick, Brooklyn, NY",
    priceDisplay: "$3,100 / month",
    priceAmount: "3100.00",
    availability: "Mid-September",
    housingType: "entire" as const,
    dateConfidence: "verify" as const,
    summary: "Open-plan loft with a separate work nook, freight elevator, and shared roof deck.",
    parkNotes: "Maria Hernandez Park is nearby.",
    attributes: { bedrooms: 1, workspace: true, roof_deck: "shared", elevator: "freight" },
  },
  {
    source: "Zillow",
    title: "Accessible one-bedroom by the train",
    location: "Jackson Heights, Queens, NY",
    priceDisplay: "$2,680 / month",
    priceAmount: "2680.00",
    availability: "September 15",
    housingType: "entire" as const,
    dateConfidence: "strong" as const,
    summary: "Elevator building with step-free entry, wide doorways, and a renovated kitchen.",
    parkNotes: "Two blocks from Travers Park.",
    attributes: { bedrooms: 1, step_free: true, elevator: true, dishwasher: true },
  },
  {
    source: "Facebook Marketplace",
    title: "Large room in artist household",
    location: "Ridgewood, Queens, NY",
    priceDisplay: "$1,325 + utilities",
    priceAmount: "1325.00",
    availability: "Date negotiable",
    housingType: "shared" as const,
    dateConfidence: "unknown" as const,
    summary: "Large unfurnished room in a three-person household with basement studio space.",
    parkNotes: "Close to Grover Cleveland Playground.",
    attributes: { furnished: false, roommates: 2, studio_space: true, pets: "one dog lives here" },
  },
  {
    source: "RentHop",
    title: "Renovated railroad apartment",
    location: "Greenpoint, Brooklyn, NY",
    priceDisplay: "$2,950 / month",
    priceAmount: "2950.00",
    availability: "Available after approval",
    housingType: "entire" as const,
    dateConfidence: "unknown" as const,
    summary: "Long railroad layout with original floors, new appliances, and ample storage.",
    parkNotes: "McGolrick Park is across the avenue.",
    attributes: { bedrooms: 1, dishwasher: true, storage: "ample", broker_fee: true },
  },
  {
    source: "Apartments.com",
    title: "Two-bedroom with balcony",
    location: "Sunset Park, Brooklyn, NY",
    priceDisplay: "$3,600 / month",
    priceAmount: "3600.00",
    availability: "September 1 or October 1",
    housingType: "entire" as const,
    dateConfidence: "strong" as const,
    summary: "Corner apartment with two real bedrooms, private balcony, and harbor views.",
    parkNotes: "One avenue from Sunset Park.",
    attributes: { bedrooms: 2, bathrooms: 1, balcony: "private", view: "harbor" },
  },
  {
    source: "Leasebreak",
    title: "Short-term sublet near Fort Greene Park",
    location: "Fort Greene, Brooklyn, NY",
    priceDisplay: "$2,400 / month",
    priceAmount: "2400.00",
    availability: "September through November",
    housingType: "entire" as const,
    dateConfidence: "strong" as const,
    summary: "Furnished one-bedroom sublet with plants, good light, and no renewal option.",
    parkNotes: "One block from Fort Greene Park.",
    attributes: { furnished: true, term_months: 3, renewal: false },
    status: "trashed" as const,
  },
  {
    source: "Zumper",
    title: "Price-unlisted carriage house",
    location: "Ditmas Park, Brooklyn, NY",
    priceDisplay: "Contact for price",
    priceAmount: null,
    availability: "Timing unclear",
    housingType: "unknown" as const,
    dateConfidence: "unknown" as const,
    summary: "Unverified carriage-house listing with a separate entrance and sparse details.",
    parkNotes: "Location appears close to Prospect Park South.",
    attributes: { bedrooms: "unverified", separate_entrance: true },
    status: "trashed" as const,
  },
] as const;

const DEMO_ENGAGEMENT = [
  {
    interestedBy: [0, 1],
    comments: [
      { author: 0, body: "The light and laundry make this worth a closer look." },
      { author: 1, body: "I can visit after work on Thursday." },
      { author: 2, body: "The park access is excellent; checking the pet policy." },
      { author: 0, body: "Added it to the shortlist." },
    ],
  },
  {
    interestedBy: [2],
    comments: [{ author: 2, body: "Flexible lease terms could make this useful." }],
  },
  {
    interestedBy: [0],
    comments: [
      { author: 0, body: "Utilities included keeps the total cost predictable." },
      { author: 1, body: "Elevator access is a meaningful advantage." },
    ],
  },
  { interestedBy: [], comments: [] },
  {
    interestedBy: [0, 1, 2],
    comments: [
      { author: 1, body: "Best accessibility match so far." },
      { author: 2, body: "The train and park combination works well." },
      { author: 0, body: "Let’s verify doorway measurements." },
    ],
  },
  { interestedBy: [], comments: [] },
  { interestedBy: [1], comments: [] },
  {
    interestedBy: [0, 2],
    comments: [{ author: 0, body: "The balcony may justify the higher price." }],
  },
  { interestedBy: [], comments: [] },
  { interestedBy: [], comments: [] },
] as const;

export async function seedDemoAccounts(): Promise<void> {
  // Keep development-only fixtures out of the production runtime image. The
  // production entrypoint rejects HOMING_DEMO_ACCOUNTS before this is called.
  const { DEMO_ACCOUNTS, DEMO_PASSWORD } = await import("../../dev/demo-accounts");
  const database = getDatabase();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await database.transaction(async (transaction) => {
    const demoUserIds: number[] = [];

    for (const account of DEMO_ACCOUNTS) {
      const [existing] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${account.email}`)
        .limit(1);

      const user = existing
        ? (
            await transaction
              .update(users)
              .set({
                passwordHash,
                passwordResetRequired: false,
                isActive: true,
                updatedAt: new Date(),
              })
              .where(eq(users.id, existing.id))
              .returning({ id: users.id })
          )[0]
        : (
            await transaction
              .insert(users)
              .values({ email: account.email, passwordHash })
              .returning({ id: users.id })
          )[0];

      if (!user) throw new Error(`Failed to seed demo account ${account.email}.`);
      demoUserIds.push(user.id);

      await transaction
        .insert(profiles)
        .values({ userId: user.id, displayName: account.displayName })
        .onConflictDoUpdate({
          target: profiles.userId,
          set: { displayName: account.displayName, updatedAt: new Date() },
        });
    }

    const activeProjects = await transaction
      .select({ id: projects.id, creatorId: projects.creatorId })
      .from(projects)
      .where(eq(projects.status, "active"));

    for (const project of activeProjects) {
      for (const userId of demoUserIds) {
        await transaction
          .insert(projectMemberships)
          .values({ projectId: project.id, userId, role: "editor" })
          .onConflictDoNothing();
      }

      for (const [index, lead] of DEMO_LEADS.entries()) {
        const sourceListingId = `homing-design-${String(index + 1).padStart(2, "0")}`;
        const [existing] = await transaction
          .select({ id: leads.id })
          .from(leads)
          .where(
            sql`${leads.projectId} = ${project.id} and ${leads.sourceListingId} = ${sourceListingId}`,
          )
          .limit(1);
        let leadId = existing?.id;
        if (leadId) {
          await transaction
            .update(leads)
            .set({
              source: lead.source,
              listedAt:
                index === 5 || index === 9
                  ? null
                  : new Date(Date.now() - (index + 1) * 86_400_000).toISOString().slice(0, 10),
            })
            .where(eq(leads.id, leadId));
        } else {
          const status = "status" in lead ? lead.status : "active";
          const timestamp = new Date(Date.now() - index * 3_600_000);
          const listedAt =
            index === 5 || index === 9
              ? null
              : new Date(Date.now() - (index + 1) * 86_400_000).toISOString().slice(0, 10);
          const [created] = await transaction
            .insert(leads)
            .values({
              projectId: project.id,
              creatorId: project.creatorId,
              source: lead.source,
              sourceListingId,
              canonicalUrl: `https://example.test/homing-design/${index + 1}`,
              sourceUrl: `https://example.test/homing-design/${index + 1}`,
              title: lead.title,
              summary: lead.summary,
              location: lead.location,
              priceDisplay: lead.priceDisplay,
              priceAmount: lead.priceAmount,
              availability: lead.availability,
              housingType: lead.housingType,
              dateConfidence: lead.dateConfidence,
              listedAt,
              parkNotes: lead.parkNotes,
              attributes: lead.attributes,
              verificationNotes:
                lead.dateConfidence === "strong"
                  ? "Core listing details verified for design review."
                  : "Fixture includes intentionally uncertain details for review states.",
              status,
              trashedById: status === "trashed" ? project.creatorId : null,
              trashedAt: status === "trashed" ? timestamp : null,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            .returning({ id: leads.id });
          leadId = created?.id;
        }

        if (!leadId) throw new Error(`Failed to seed demo lead ${sourceListingId}.`);
        const engagement = DEMO_ENGAGEMENT[index];
        if (!engagement) throw new Error(`Missing demo engagement for ${sourceListingId}.`);

        for (const accountIndex of engagement.interestedBy) {
          const userId = demoUserIds[accountIndex];
          if (!userId) continue;
          await transaction.insert(leadInterests).values({ leadId, userId }).onConflictDoNothing();
        }

        for (const comment of engagement.comments) {
          const authorId = demoUserIds[comment.author];
          if (!authorId) continue;
          const [existingComment] = await transaction
            .select({ id: leadComments.id })
            .from(leadComments)
            .where(
              and(
                eq(leadComments.leadId, leadId),
                eq(leadComments.authorId, authorId),
                eq(leadComments.body, comment.body),
                isNull(leadComments.deletedAt),
              ),
            )
            .limit(1);
          if (!existingComment) {
            await transaction.insert(leadComments).values({ leadId, authorId, body: comment.body });
          }
        }
      }
    }
  });
}

if (import.meta.main) await seedDemoAccounts();
