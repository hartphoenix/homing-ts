#!/bin/sh
set -eu

: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"
: "${POSTGRES_APP_USER:?POSTGRES_APP_USER is required}"

# Migrations create tables under the migration role's default privileges. Remove runtime access to
# deployment evidence after every migration run, then prove the denial before web can start.
exec psql "$DATABASE_ADMIN_URL" <<'SQL'
\set ON_ERROR_STOP on
\getenv app_user POSTGRES_APP_USER

SELECT format('REVOKE ALL PRIVILEGES ON TABLE public.migration_records FROM %I', :'app_user')
WHERE to_regclass('public.migration_records') IS NOT NULL\gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA drizzle FROM %I', :'app_user')
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle')\gexec
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA drizzle FROM %I', :'app_user')
WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle')\gexec

SELECT (
  has_table_privilege(:'app_user', 'public.migration_records', 'INSERT') OR
  has_table_privilege(:'app_user', 'public.migration_records', 'UPDATE') OR
  has_table_privilege(:'app_user', 'public.migration_records', 'DELETE')
)::int AS runtime_can_mutate_migration_records \gset
\if :runtime_can_mutate_migration_records
  \echo 'runtime role can mutate migration evidence'
  \quit 1
\endif
SQL
