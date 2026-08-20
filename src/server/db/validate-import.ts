import { z } from "zod";

import { closeDatabase, getSqlClient } from "./client";

const input = z.object({ MIGRATE_PROJECT_ID: z.string().uuid() }).parse(process.env);

type ValidationRow = {
  project_count: number;
  member_count: number;
  owner_count: number;
  profile_count: number;
  creator_is_member: boolean;
  prompt_revision: number;
  matching_revision_count: number;
  latest_change_sequence: number;
  feed_epoch: string;
  unsupported_unmarked_passwords: number;
  token_count: number;
  session_count: number;
  change_count: number;
  source_checksum: string | null;
  target_checksum: string | null;
};

const database = getSqlClient();
const rows = await database<ValidationRow[]>`
  with target_project as (
    select * from projects where id = ${input.MIGRATE_PROJECT_ID}::uuid
  ), target_memberships as (
    select membership.*
      from project_memberships membership
      join target_project project on project.id = membership.project_id
  )
  select
    (select count(*)::int from target_project) as project_count,
    (select count(*)::int from target_memberships) as member_count,
    (select count(*)::int from target_memberships where role = 'owner') as owner_count,
    (
      select count(*)::int from profiles profile
       join target_memberships membership on membership.user_id = profile.user_id
    ) as profile_count,
    exists (
      select 1 from target_project project
       join target_memberships membership on membership.user_id = project.creator_id
    ) as creator_is_member,
    coalesce((select prompt_revision from target_project), 0)::int as prompt_revision,
    (
      select count(*)::int from prompt_revisions current_revision
       where current_revision.project_id = ${input.MIGRATE_PROJECT_ID}::uuid
         and current_revision.revision = coalesce(
           (select prompt_revision from target_project), 0
         )
    ) as matching_revision_count,
    coalesce((select latest_change_sequence from target_project), 0)::int as latest_change_sequence,
    coalesce((select feed_epoch from target_project), '') as feed_epoch,
    (
      select count(*)::int
        from users imported_user
        join target_memberships imported_membership on imported_membership.user_id = imported_user.id
       where split_part(imported_user.password_hash, '$', 1) not in ('argon2', 'pbkdf2_sha256')
         and imported_user.password_hash not like '$argon2id$%'
         and imported_user.password_hash not like '$argon2i$%'
         and imported_user.password_reset_required = false
    ) as unsupported_unmarked_passwords,
    (select count(*)::int from agent_tokens) as token_count,
    (select count(*)::int from sessions) as session_count,
    (
      select count(*)::int from project_changes imported_change
       where imported_change.project_id = ${input.MIGRATE_PROJECT_ID}::uuid
    ) as change_count,
    (select source_checksum from migration_records where source_project_id = ${input.MIGRATE_PROJECT_ID}::uuid) as source_checksum,
    (select target_checksum from migration_records where source_project_id = ${input.MIGRATE_PROJECT_ID}::uuid) as target_checksum
`;

const result = rows[0];
if (!result) throw new Error("Import validation returned no result.");

const violations: string[] = [];
if (result.project_count !== 1) violations.push("project_count");
if (result.member_count < 1) violations.push("member_count");
if (result.owner_count < 1) violations.push("owner_count");
if (result.profile_count !== result.member_count) violations.push("profile_count");
if (!result.creator_is_member) violations.push("creator_membership");
if (result.prompt_revision > 0 && result.matching_revision_count !== 1) {
  violations.push("prompt_revision");
}
if (!/^[a-f0-9]{32}$/.test(result.feed_epoch)) violations.push("feed_epoch");
if (result.latest_change_sequence !== 0 || result.change_count !== 0) {
  violations.push("change_feed_not_fresh");
}
if (result.unsupported_unmarked_passwords !== 0) violations.push("password_support_marker");
if (result.token_count !== 0 || result.session_count !== 0)
  violations.push("credential_state_not_fresh");
if (!result.source_checksum || !result.target_checksum) violations.push("migration_record");

console.log(
  JSON.stringify({
    event: "migration_validation",
    valid: violations.length === 0,
    project_id: input.MIGRATE_PROJECT_ID,
    counts: {
      projects: result.project_count,
      members: result.member_count,
      owners: result.owner_count,
      profiles: result.profile_count,
      prompt_revisions: result.matching_revision_count,
      tokens: result.token_count,
      sessions: result.session_count,
      changes: result.change_count,
    },
    source_checksum: result.source_checksum,
    target_checksum: result.target_checksum,
    violations,
  }),
);

await closeDatabase();
if (violations.length) process.exitCode = 1;
