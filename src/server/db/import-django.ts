import { z } from "zod";

import {
  createMigrationClient,
  type ImportState,
  mismatchedStateTables,
  readDjangoRotationCounts,
  readDjangoState,
  readTypeScriptState,
  stateChecksum,
  stateCounts,
} from "./django-import-state";

const inputSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  DJANGO_DATABASE_URL: z.string().startsWith("postgresql://"),
  MIGRATION_CUTOVER_AT: z.string().datetime({ offset: true }),
});

async function importState(
  target: ReturnType<typeof createMigrationClient>,
  state: ImportState,
  sourceChecksum: string,
): Promise<string> {
  return target.begin(async (transaction) => {
    await transaction`set local time zone 'UTC'`;
    await transaction`select pg_advisory_xact_lock(hashtext('homing-ts-django-import'))`;
    const records = await transaction<
      {
        source_project_id: string;
        source_checksum: string;
        target_checksum: string;
        target_exists: boolean;
      }[]
    >`
      select record.source_project_id::text, record.source_checksum, record.target_checksum,
             exists(select 1 from projects where id = record.source_project_id) as target_exists
        from migration_records record
       order by record.source_project_id
    `;
    if (records.length) {
      const expectedProjects = new Set(state.projects.map((project) => project.id));
      if (
        records.length !== expectedProjects.size ||
        records.some(
          (record) =>
            !expectedProjects.has(record.source_project_id) ||
            record.source_checksum !== sourceChecksum ||
            !record.target_exists,
        )
      ) {
        throw new Error("Recorded import does not match the complete frozen source.");
      }
      const targetChecksums = new Set(records.map((record) => record.target_checksum));
      if (targetChecksums.size !== 1) throw new Error("Recorded target checksums disagree.");
      const actualTargetChecksum = stateChecksum(await readTypeScriptState(transaction));
      if (!targetChecksums.has(actualTargetChecksum)) {
        throw new Error("Target changed after the recorded import.");
      }
      return actualTargetChecksum;
    }

    const [collision] = await transaction<{ application_rows: number }[]>`
      select (
        (select count(*) from users) +
        (select count(*) from profiles) +
        (select count(*) from sessions) +
        (select count(*) from auth_throttles) +
        (select count(*) from saved_prompts) +
        (select count(*) from agent_tokens) +
        (select count(*) from agent_links) +
        (select count(*) from projects) +
        (select count(*) from project_memberships) +
        (select count(*) from project_invitations) +
        (select count(*) from prompt_revisions) +
        (select count(*) from search_runs) +
        (select count(*) from leads) +
        (select count(*) from lead_interests) +
        (select count(*) from lead_comments) +
        (select count(*) from project_changes) +
        (select count(*) from source_plan_reviews) +
        (select count(*) from idempotency_keys) +
        (select count(*) from audit_events)
      )::int as application_rows
    `;
    if ((collision?.application_rows ?? -1) !== 0) {
      throw new Error("Every target application table must be empty before the Django import.");
    }

    await transaction`
      insert into users ${transaction(
        state.users.map((user) => ({
          id: user.id,
          email: user.email,
          password_hash: user.password_hash,
          password_reset_required: user.password_reset_required,
          last_login: user.last_login,
          legacy_is_staff: user.is_staff,
          legacy_is_superuser: user.is_superuser,
          is_active: user.is_active,
          created_at: user.date_joined,
          updated_at: user.updated_at,
        })),
      )}
    `;
    await transaction`
      insert into profiles ${transaction(
        state.users.map((user) => ({
          user_id: user.id,
          display_name: user.display_name,
          timezone: user.timezone,
          bio: user.bio,
          personal_details: transaction.typed(user.personal_details, 3802),
          agent_paused_until: user.agent_paused_until,
          updated_at: user.profile_updated_at,
        })),
      )}
    `;
    if (state.authThrottles.length) {
      await transaction`insert into auth_throttles ${transaction(state.authThrottles)}`;
    }
    if (state.savedPrompts.length) {
      await transaction`insert into saved_prompts ${transaction(state.savedPrompts)}`;
    }

    const feedEpochs = new Map(
      state.projects.map((project) => [project.id, crypto.randomUUID().replaceAll("-", "")]),
    );
    await transaction`
      insert into projects ${transaction(
        state.projects.map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          description: project.description,
          current_prompt: project.prompt,
          criteria: transaction.typed(project.criteria, 3802),
          status: project.status,
          creator_id: project.creator_id,
          prompt_revision: project.prompt_revision,
          latest_change_sequence: project.latest_change_sequence,
          feed_epoch: feedEpochs.get(project.id),
          created_at: project.created_at,
          updated_at: project.updated_at,
        })),
      )}
    `;
    await transaction`insert into project_memberships ${transaction(state.memberships)}`;
    if (state.invitations.length) {
      await transaction`insert into project_invitations ${transaction(state.invitations)}`;
    }
    if (state.promptRevisions.length) {
      await transaction`
        insert into prompt_revisions ${transaction(
          state.promptRevisions.map((revision) => ({
            ...revision,
            criteria: transaction.typed(revision.criteria, 3802),
          })),
        )}
      `;
    }
    if (state.tokens.length) {
      await transaction`
        insert into agent_tokens ${transaction(
          state.tokens.map((token) => ({
            ...token,
            scopes: transaction.typed(token.scopes, 3802),
            project_ids: transaction.typed(token.project_ids, 3802),
          })),
        )}
      `;
    }
    if (state.links.length) {
      await transaction`insert into agent_links ${transaction(state.links)}`;
    }
    if (state.searchRuns.length) {
      await transaction`
        insert into search_runs ${transaction(
          state.searchRuns.map((run) => ({
            ...run,
            criteria_snapshot: transaction.typed(run.criteria_snapshot, 3802),
            continuation: transaction.typed(run.continuation, 3802),
            result_counts: transaction.typed(run.result_counts, 3802),
          })),
        )}
      `;
    }
    if (state.leads.length) {
      await transaction`
        insert into leads ${transaction(
          state.leads.map((lead) => ({
            ...lead,
            attributes: transaction.typed(lead.attributes, 3802),
          })),
        )}
      `;
    }
    if (state.interests.length) {
      await transaction`insert into lead_interests ${transaction(state.interests)}`;
    }
    if (state.comments.length) {
      await transaction`insert into lead_comments ${transaction(state.comments)}`;
    }
    if (state.changes.length) {
      await transaction`
        insert into project_changes ${transaction(
          state.changes.map((change) => ({
            ...change,
            payload: transaction.typed(change.payload, 3802),
          })),
        )}
      `;
    }
    if (state.reviews.length) {
      await transaction`insert into source_plan_reviews ${transaction(state.reviews)}`;
    }
    if (state.idempotencyKeys.length) {
      await transaction`
        insert into idempotency_keys ${transaction(
          state.idempotencyKeys.map((key) => ({
            ...key,
            response_body:
              key.response_body === null ? null : transaction.typed(key.response_body, 3802),
          })),
        )}
      `;
    }
    if (state.auditEvents.length) {
      await transaction`
        insert into audit_events ${transaction(
          state.auditEvents.map((event) => ({
            ...event,
            summary: transaction.typed(event.summary, 3802),
          })),
        )}
      `;
    }

    await transaction`
      select setval(pg_get_serial_sequence('users', 'id'), (select max(id) from users), true)
    `;
    if (state.savedPrompts.length) {
      await transaction`
        select setval(pg_get_serial_sequence('saved_prompts', 'id'), (select max(id) from saved_prompts), true)
      `;
    }
    if (state.promptRevisions.length) {
      await transaction`
        select setval(pg_get_serial_sequence('prompt_revisions', 'id'), (select max(id) from prompt_revisions), true)
      `;
    }
    if (state.comments.length) {
      await transaction`
        select setval(pg_get_serial_sequence('lead_comments', 'id'), (select max(id) from lead_comments), true)
      `;
    }
    if (state.changes.length) {
      await transaction`
        select setval(pg_get_serial_sequence('project_changes', 'id'), (select max(id) from project_changes), true)
      `;
    }
    if (state.idempotencyKeys.length) {
      await transaction`
        select setval(pg_get_serial_sequence('idempotency_keys', 'id'), (select max(id) from idempotency_keys), true)
      `;
    }
    if (state.auditEvents.length) {
      await transaction`
        select setval(pg_get_serial_sequence('audit_events', 'id'), (select max(id) from audit_events), true)
      `;
    }

    const targetState = await readTypeScriptState(transaction);
    const targetChecksum = stateChecksum(targetState);
    if (targetChecksum !== sourceChecksum) {
      throw new Error(
        `Imported target does not exactly match canonical Django tables: ${mismatchedStateTables(
          state,
          targetState,
        ).join(", ")}`,
      );
    }
    await transaction`
      insert into migration_records ${transaction(
        state.projects.map((project) => ({
          source_project_id: project.id,
          source_checksum: sourceChecksum,
          target_checksum: targetChecksum,
        })),
      )}
    `;
    return targetChecksum;
  });
}

const input = inputSchema.parse(process.env);
const state = await readDjangoState(input.DJANGO_DATABASE_URL, input.MIGRATION_CUTOVER_AT);
console.log(
  JSON.stringify({
    event: "source_password_support",
    supported: state.users.filter((user) => !user.password_reset_required).length,
    reset_required: state.users.filter((user) => user.password_reset_required).length,
  }),
);
const authorityRotation = await readDjangoRotationCounts(
  input.DJANGO_DATABASE_URL,
  input.MIGRATION_CUTOVER_AT,
);
const sourceChecksum = stateChecksum(state);
const target = createMigrationClient(input.DATABASE_URL);
const targetChecksum = await importState(target, state, sourceChecksum);
console.log(
  JSON.stringify({
    event: "migration_complete",
    counts: stateCounts(state),
    authority_rotation: authorityRotation,
    source_checksum: sourceChecksum,
    target_checksum: targetChecksum,
  }),
);
await target.end({ timeout: 5 });
