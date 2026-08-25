import { z } from "zod";

import {
  createMigrationClient,
  readDjangoRotationCounts,
  readDjangoState,
  readTypeScriptState,
  stateChecksum,
  stateCounts,
} from "./django-import-state";

const input = z
  .object({
    DJANGO_DATABASE_URL: z.string().startsWith("postgresql://"),
    DATABASE_URL: z.string().startsWith("postgresql://"),
    MIGRATION_CUTOVER_AT: z.string().datetime({ offset: true }),
  })
  .parse(process.env);

const database = createMigrationClient(input.DATABASE_URL);
await database`set time zone 'UTC'`;
const source = await readDjangoState(input.DJANGO_DATABASE_URL, input.MIGRATION_CUTOVER_AT);
const authorityRotation = await readDjangoRotationCounts(
  input.DJANGO_DATABASE_URL,
  input.MIGRATION_CUTOVER_AT,
);
const target = await readTypeScriptState(database);
const sourceChecksum = stateChecksum(source);
const targetChecksum = stateChecksum(target);
const sourceProjectIds = source.projects.map((project) => project.id).sort();
const activeResetRequired = target.users.filter(
  (user) => user.is_active && user.password_reset_required,
).length;

const records = await database<
  { source_project_id: string; source_checksum: string; target_checksum: string }[]
>`
  select source_project_id::text, source_checksum, target_checksum
    from migration_records order by source_project_id
`;
const [credentialState] = await database<
  { session_count: number; unsupported_unmarked_passwords: number }[]
>`
  select
    (select count(*)::int from sessions) as session_count,
    (
      select count(*)::int from users
       where split_part(password_hash, '$', 1) not in ('argon2', 'pbkdf2_sha256')
         and password_hash not like '$argon2id$%'
         and password_hash not like '$argon2i$%'
         and password_reset_required = false
    ) as unsupported_unmarked_passwords
`;
const feedEpochs = await database<{ id: string; feed_epoch: string }[]>`
  select id::text, feed_epoch from projects order by id
`;

const violations: string[] = [];
if (sourceChecksum !== targetChecksum) violations.push("canonical_state_mismatch");
if (JSON.stringify(stateCounts(source)) !== JSON.stringify(stateCounts(target))) {
  violations.push("table_count_mismatch");
}
if (
  records.length !== sourceProjectIds.length ||
  records.some(
    (record, index) =>
      record.source_project_id !== sourceProjectIds[index] ||
      record.source_checksum !== sourceChecksum ||
      record.target_checksum !== targetChecksum,
  )
) {
  violations.push("migration_record_mismatch");
}
if (feedEpochs.some((project) => !/^[a-f0-9]{32}$/.test(project.feed_epoch))) {
  violations.push("feed_epoch");
}
if ((credentialState?.session_count ?? -1) !== 0) violations.push("sessions_not_fresh");
if ((credentialState?.unsupported_unmarked_passwords ?? -1) !== 0) {
  violations.push("password_support_marker");
}

console.log(
  JSON.stringify({
    event: "migration_validation",
    valid: violations.length === 0,
    projects: sourceProjectIds,
    source_counts: stateCounts(source),
    target_counts: stateCounts(target),
    source_checksum: sourceChecksum,
    target_checksum: targetChecksum,
    browser_sessions: credentialState?.session_count ?? -1,
    active_password_resets_required: activeResetRequired,
    authority_rotation: authorityRotation,
    violations,
  }),
);

await database.end({ timeout: 5 });
if (violations.length) process.exitCode = 1;
