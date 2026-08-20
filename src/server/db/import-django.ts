import postgres from "postgres";
import { z } from "zod";

import { closeDatabase, getSqlClient } from "./client";

const inputSchema = z.object({
  DJANGO_DATABASE_URL: z.string().startsWith("postgresql://"),
  MIGRATE_PROJECT_ID: z.string().uuid(),
});

type SourceUser = {
  id: number;
  email: string;
  password_hash: string;
  is_active: boolean;
  date_joined: Date;
  updated_at: Date;
  display_name: string;
  timezone: string;
  bio: string;
  personal_details: Record<string, unknown>;
  agent_paused_until: Date | null;
  profile_updated_at: Date;
};

type SourceProject = {
  id: string;
  name: string;
  slug: string;
  description: string;
  prompt: string;
  criteria: Record<string, unknown>;
  status: "active" | "trashed";
  prompt_revision: number;
  creator_id: number;
  created_at: Date;
  updated_at: Date;
};

type SourceMembership = {
  user_id: number;
  role: "owner" | "editor" | "viewer";
  joined_at: Date;
};

type SourcePromptRevision = {
  revision: number;
  prompt: string;
  criteria: Record<string, unknown>;
  editor_id: number;
  created_at: Date;
};

type ImportState = {
  users: SourceUser[];
  project: SourceProject;
  memberships: SourceMembership[];
  promptRevision: SourcePromptRevision | null;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function checksum(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(stableValue(value)));
  return hasher.digest("hex");
}

function validateState(state: ImportState): void {
  const normalizedEmails = new Set<string>();
  const userIds = new Set(state.users.map((user) => user.id));
  for (const user of state.users) {
    const email = user.email.trim().toLowerCase();
    if (normalizedEmails.has(email))
      throw new Error("Source contains a normalized email collision.");
    normalizedEmails.add(email);
    if (!user.display_name.trim())
      throw new Error("Source contains a user without a profile name.");
  }
  if (!userIds.has(state.project.creator_id))
    throw new Error("Project creator is not a member user.");
  if (!state.memberships.length) throw new Error("Project has no memberships.");
  if (!state.memberships.some((membership) => membership.role === "owner")) {
    throw new Error("Project has no owner.");
  }
  for (const membership of state.memberships) {
    if (!userIds.has(membership.user_id)) throw new Error("Membership references an unknown user.");
    if (!(["owner", "editor", "viewer"] as const).includes(membership.role)) {
      throw new Error("Membership has an unknown role.");
    }
  }
  if (state.project.prompt_revision > 0) {
    if (!state.promptRevision || state.promptRevision.revision !== state.project.prompt_revision) {
      throw new Error("Current prompt revision is missing or inconsistent.");
    }
  }
}

async function readSource(sourceUrl: string, projectId: string): Promise<ImportState> {
  const source = postgres(sourceUrl, { max: 1, prepare: false });
  try {
    return await source.begin(async (transaction) => {
      await transaction`set transaction read only`;
      const projectRows = await transaction<SourceProject[]>`
        select id::text, name, slug, description, prompt, criteria, status, prompt_revision,
               creator_id, created_at, updated_at
          from projects_project
         where id = ${projectId}::uuid
      `;
      const project = projectRows[0];
      if (!project) throw new Error("Source project does not exist.");

      const users = await transaction<SourceUser[]>`
        select u.id, u.email, u.password as password_hash, u.is_active, u.date_joined, u.updated_at,
               p.display_name, p.timezone, p.bio, p.personal_details, p.agent_paused_until,
               p.updated_at as profile_updated_at
          from projects_projectmembership m
          join accounts_user u on u.id = m.user_id
          join accounts_profile p on p.user_id = u.id
         where m.project_id = ${projectId}::uuid
         order by u.id
      `;
      const memberships = await transaction<SourceMembership[]>`
        select user_id, role, joined_at
          from projects_projectmembership
         where project_id = ${projectId}::uuid
         order by user_id
      `;
      const promptRows =
        project.prompt_revision > 0
          ? await transaction<SourcePromptRevision[]>`
              select revision, prompt, criteria, editor_id, created_at
                from projects_promptrevision
               where project_id = ${projectId}::uuid
                 and revision = ${project.prompt_revision}
            `
          : [];

      const state = {
        users,
        project,
        memberships,
        promptRevision: promptRows[0] ?? null,
      } satisfies ImportState;
      validateState(state);
      return state;
    });
  } finally {
    await source.end({ timeout: 5 });
  }
}

async function algorithmCounts(sourceUrl: string, projectId: string) {
  const source = postgres(sourceUrl, { max: 1, prepare: false });
  try {
    return await source<{ algorithm: string; count: number }[]>`
      select split_part(u.password, '$', 1) as algorithm, count(*)::int as count
        from projects_projectmembership m
        join accounts_user u on u.id = m.user_id
       where m.project_id = ${projectId}::uuid
       group by split_part(u.password, '$', 1)
       order by algorithm
    `;
  } finally {
    await source.end({ timeout: 5 });
  }
}

async function importState(state: ImportState, sourceChecksum: string): Promise<string> {
  const target = getSqlClient();
  return target.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtext('homing-ts-django-import'))`;
    const records = await transaction<{ source_checksum: string; target_checksum: string }[]>`
      select source_checksum, target_checksum
        from migration_records
       where source_project_id = ${state.project.id}::uuid
    `;
    const existing = records[0];
    if (existing) {
      if (existing.source_checksum !== sourceChecksum) {
        throw new Error("Source changed after the recorded import.");
      }
      return existing.target_checksum;
    }

    const collisions = await transaction<{ count: number }[]>`
      select (
        (select count(*) from projects where id = ${state.project.id}::uuid) +
        (select count(*) from users where id in ${transaction(state.users.map((user) => user.id))}) +
        (select count(*) from users where lower(email) in ${transaction(
          state.users.map((user) => user.email.trim().toLowerCase()),
        )})
      )::int as count
    `;
    if ((collisions[0]?.count ?? 0) > 0) {
      throw new Error("Target contains a partial or colliding import.");
    }

    await transaction`
      insert into users ${transaction(
        state.users.map((user) => ({
          id: user.id,
          email: user.email.trim().toLowerCase(),
          password_hash: user.password_hash,
          password_reset_required: !["argon2", "pbkdf2_sha256"].includes(
            user.password_hash.split("$", 1)[0] ?? "",
          ),
          is_active: user.is_active,
          created_at: user.date_joined,
          updated_at: user.updated_at,
        })),
      )}
    `;
    for (const user of state.users) {
      await transaction`
        insert into profiles (
          user_id, display_name, timezone, bio, personal_details, agent_paused_until, updated_at
        ) values (
          ${user.id}, ${user.display_name}, ${user.timezone}, ${user.bio},
          ${JSON.stringify(user.personal_details)}::jsonb, ${user.agent_paused_until},
          ${user.profile_updated_at}
        )
      `;
    }

    const feedEpoch = crypto.randomUUID().replaceAll("-", "");
    await transaction`
      insert into projects (
        id, name, slug, description, current_prompt, criteria, status, creator_id,
        prompt_revision, latest_change_sequence, feed_epoch, created_at, updated_at
      ) values (
        ${state.project.id}::uuid, ${state.project.name}, ${state.project.slug},
        ${state.project.description}, ${state.project.prompt}, ${JSON.stringify(state.project.criteria)}::jsonb,
        ${state.project.status}::project_status, ${state.project.creator_id},
        ${state.project.prompt_revision}, 0, ${feedEpoch}, ${state.project.created_at},
        ${state.project.updated_at}
      )
    `;
    await transaction`
      insert into project_memberships ${transaction(
        state.memberships.map((membership) => ({
          project_id: state.project.id,
          user_id: membership.user_id,
          role: membership.role,
          joined_at: membership.joined_at,
        })),
      )}
    `;
    if (state.promptRevision) {
      await transaction`
        insert into prompt_revisions (project_id, revision, prompt, criteria, editor_id, created_at)
        values (
          ${state.project.id}::uuid, ${state.promptRevision.revision}, ${state.promptRevision.prompt},
          ${JSON.stringify(state.promptRevision.criteria)}::jsonb, ${state.promptRevision.editor_id},
          ${state.promptRevision.created_at}
        )
      `;
    }
    await transaction`
      select setval(
        pg_get_serial_sequence('users', 'id'),
        greatest((select coalesce(max(id), 1) from users), 1),
        true
      )
    `;

    const targetChecksum = checksum({ ...state, feedEpoch });
    await transaction`
      insert into migration_records (source_project_id, source_checksum, target_checksum)
      values (${state.project.id}::uuid, ${sourceChecksum}, ${targetChecksum})
    `;
    return targetChecksum;
  });
}

const input = inputSchema.parse(process.env);
const algorithms = await algorithmCounts(input.DJANGO_DATABASE_URL, input.MIGRATE_PROJECT_ID);
console.log(JSON.stringify({ event: "source_password_algorithms", algorithms }));
const state = await readSource(input.DJANGO_DATABASE_URL, input.MIGRATE_PROJECT_ID);
const sourceChecksum = checksum(state);
const targetChecksum = await importState(state, sourceChecksum);
console.log(
  JSON.stringify({
    event: "migration_complete",
    users: state.users.length,
    memberships: state.memberships.length,
    projects: 1,
    source_checksum: sourceChecksum,
    target_checksum: targetChecksum,
  }),
);
await closeDatabase();
