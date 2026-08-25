#!/bin/sh
set -eu

: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_APP_USER:?POSTGRES_APP_USER is required}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
: "${POSTGRES_MIGRATION_USER:?POSTGRES_MIGRATION_USER is required}"
: "${POSTGRES_MIGRATION_PASSWORD:?POSTGRES_MIGRATION_PASSWORD is required}"

# psql's \getenv keeps credentials out of command arguments and logs. The
# admin URL is used only by this one-shot provisioning step; web never gets it.
exec psql "$DATABASE_ADMIN_URL" <<'SQL'
\set ON_ERROR_STOP on
\getenv app_user POSTGRES_APP_USER
\getenv app_password POSTGRES_APP_PASSWORD
\getenv migration_user POSTGRES_MIGRATION_USER
\getenv migration_password POSTGRES_MIGRATION_PASSWORD

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')\gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'app_user', :'app_password')\gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'migration_user', :'migration_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'migration_user')\gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'migration_user', :'migration_password')\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'migration_user')\gexec
SELECT format('GRANT CREATE ON DATABASE %I TO %I', current_database(), :'migration_user')\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user')\gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migration_user')\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user')\gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user')\gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user')\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'migration_user', :'app_user')\gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'migration_user', :'app_user')\gexec

-- Make rerunning provisioning safe for a database whose tables were created
-- by the initial admin role before role separation was introduced.
SELECT format('ALTER SCHEMA %I OWNER TO %I', nspname, :'migration_user')
FROM pg_namespace WHERE nspname = 'drizzle'\gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', schemaname, tablename, :'migration_user')
FROM pg_tables WHERE schemaname IN ('public', 'drizzle')\gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', sequence_schema, sequence_name, :'migration_user')
FROM information_schema.sequences WHERE sequence_schema IN ('public', 'drizzle')\gexec
SELECT format('ALTER TYPE %I.%I OWNER TO %I', namespace.nspname, type.typname, :'migration_user')
FROM pg_type type
JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
WHERE namespace.nspname IN ('public', 'drizzle')
  AND type.typtype = 'e'
  AND pg_get_userbyid(type.typowner) = current_user\gexec
SQL
