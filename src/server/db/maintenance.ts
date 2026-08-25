import { sql } from "drizzle-orm";

import { closeDatabase, getDatabase } from "./client";

const database = getDatabase();
const result = await database.execute(sql`
  with expired_sessions as (
    delete from sessions where expires_at <= now() returning 1
  ), expired_keys as (
    delete from idempotency_keys where expires_at <= now() returning 1
  ), expired_links as (
    delete from agent_links
     where (expires_at <= now() or status in ('consumed', 'denied', 'expired'))
       and created_at < now() - interval '7 days'
     returning 1
  ), expired_throttles as (
    delete from auth_throttles
     where updated_at < now() - interval '30 days'
       and (blocked_until is null or blocked_until < now())
     returning 1
  )
  select
    (select count(*)::int from expired_sessions) as sessions,
    (select count(*)::int from expired_keys) as idempotency_keys,
    (select count(*)::int from expired_links) as agent_links,
    (select count(*)::int from expired_throttles) as auth_throttles
`);

console.log(JSON.stringify({ event: "maintenance_complete", deleted: result[0] }));
await closeDatabase();
