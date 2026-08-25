#!/bin/sh
set -eu
umask 077

project_dir=${PROJECT_DIR:-"$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"}
target_env=${HOMING_ENV_FILE:-"$project_dir/.env"}
source_dir=${DJANGO_PROJECT_DIR:-/opt/homing}
source_env=${DJANGO_ENV_FILE:-"$source_dir/.env"}
cutover_at=${MIGRATION_CUTOVER_AT:-}

test -n "$cutover_at" || { echo "MIGRATION_CUTOVER_AT is required" >&2; exit 1; }
test -f "$target_env" || { echo "missing target environment file" >&2; exit 1; }
test -f "$source_env" || { echo "missing Django environment file" >&2; exit 1; }
test -f "$source_dir/compose.yaml" || { echo "missing Django compose.yaml" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

python3 - "$cutover_at" <<'PY'
from datetime import datetime
import sys

value = sys.argv[1]
if not value.endswith("Z"):
    raise SystemExit("MIGRATION_CUTOVER_AT must be an explicit UTC timestamp ending in Z")
try:
    datetime.fromisoformat(value[:-1] + "+00:00")
except ValueError as error:
    raise SystemExit("MIGRATION_CUTOVER_AT is invalid") from error
PY

read_env_value() {
  file=$1
  key=$2
  awk -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $0 ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=/ {
      line=$0
      sub(/^[[:space:]]*/, "", line)
      name=line
      sub(/=.*/, "", name)
      if (name == key) { sub(/^[^=]*=/, "", line); print line; exit }
    }
  ' "$file"
}

target_project=$(read_env_value "$target_env" COMPOSE_PROJECT_NAME)
source_project=$(read_env_value "$source_env" COMPOSE_PROJECT_NAME)
target_project=${target_project:-homing-ts}
source_project=${source_project:-homing}
docker_context=${HOMING_DOCKER_CONTEXT:-default}

for project in "$target_project" "$source_project"; do
  case "$project" in
    ""|*[!A-Za-z0-9_-]*)
      echo "Compose project names must contain only letters, digits, underscores, and hyphens" >&2
      exit 1
      ;;
  esac
done
case "$docker_context" in
  ""|*[!A-Za-z0-9_.-]*)
    echo "HOMING_DOCKER_CONTEXT contains unsupported characters" >&2
    exit 1
    ;;
esac

docker_cmd() {
  docker --context "$docker_context" "$@"
}
target_compose() {
  docker_cmd compose --project-name "$target_project" --env-file "$target_env" \
    -f "$project_dir/compose.yaml" "$@"
}
source_compose() {
  docker_cmd compose --project-name "$source_project" --env-file "$source_env" \
    -f "$source_dir/compose.yaml" "$@"
}

test -z "$(source_compose ps --status running -q web)" || {
  echo "Django web must be stopped before import" >&2
  exit 1
}
test -z "$(source_compose ps --status running -q caddy)" || {
  echo "Django Caddy must be stopped before import" >&2
  exit 1
}
test -z "$(target_compose ps --status running -q web)" || {
  echo "replacement web must be stopped before import" >&2
  exit 1
}
test -z "$(target_compose ps --status running -q caddy)" || {
  echo "replacement Caddy must be stopped before import" >&2
  exit 1
}

source_db=$(source_compose ps --status running -q db)
target_db=$(target_compose ps --status running -q db)
test -n "$source_db" || { echo "Django database is not running" >&2; exit 1; }
test -n "$target_db" || { echo "target database is not running" >&2; exit 1; }

target_network=$(docker_cmd inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$target_db" | awk '/_database$/ { print; exit }')
test -n "$target_network" || { echo "target database network not found" >&2; exit 1; }

source_database=$(docker_cmd exec "$source_db" sh -c 'printf %s "$POSTGRES_DB"')
case "$source_database" in
  ""|*[!A-Za-z0-9_]* ) echo "Django database name is not a safe identifier" >&2; exit 1 ;;
esac
source_psql() {
  docker_cmd exec -i "$source_db" sh -c '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    exec psql --host=127.0.0.1 -v ON_ERROR_STOP=1 \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  '
}

suffix=$(openssl rand -hex 8)
source_role="homing_ts_import_$suffix"
source_password=$(openssl rand -hex 32)
source_alias="django-source-$suffix"
role_created=0
network_connected=0
main_completed=0

cleanup() {
  main_status=$?
  trap - EXIT HUP INT TERM
  cleanup_failed=0
  if [ "$role_created" -eq 1 ]; then
    if ! docker_cmd inspect "$source_db" >/dev/null 2>&1; then
      echo "cannot inspect Django database while dropping temporary import role" >&2
      cleanup_failed=1
    elif ! source_psql <<SQL >/dev/null 2>&1
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '$source_role';
DROP OWNED BY "$source_role";
DROP ROLE IF EXISTS "$source_role";
SQL
    then
      echo "failed to drop temporary Django import role" >&2
      cleanup_failed=1
    fi
  fi
  if [ "$network_connected" -eq 1 ]; then
    if ! docker_cmd network disconnect "$target_network" "$source_db" >/dev/null 2>&1; then
      echo "failed to disconnect temporary Django import network" >&2
      cleanup_failed=1
    fi
  fi
  source_password=
  DJANGO_DATABASE_URL=
  export DJANGO_DATABASE_URL
  if [ "$cleanup_failed" -ne 0 ]; then
    echo "temporary Django import cleanup is incomplete; manual intervention required" >&2
    main_status=125
  fi
  if [ "$main_status" -eq 0 ] && [ "$main_completed" -eq 1 ]; then
    echo "frozen Django import, validation, and cleanup completed"
  fi
  exit "$main_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT TERM

docker_cmd network connect --alias "$source_alias" "$target_network" "$source_db"
network_connected=1

role_created=1
source_psql <<SQL >/dev/null
CREATE ROLE "$source_role" LOGIN PASSWORD '$source_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE "$source_role" SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE "$source_database" TO "$source_role";
GRANT USAGE ON SCHEMA public TO "$source_role";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "$source_role";
SQL

DJANGO_DATABASE_URL="postgresql://$source_role:$source_password@$source_alias:5432/$source_database"
MIGRATION_CUTOVER_AT=$cutover_at
export DJANGO_DATABASE_URL
export MIGRATION_CUTOVER_AT

target_compose run --rm --no-deps --no-TTY \
  -e DJANGO_DATABASE_URL -e MIGRATION_CUTOVER_AT migrate bun run db:import-django
target_compose run --rm --no-deps --no-TTY \
  -e DJANGO_DATABASE_URL -e MIGRATION_CUTOVER_AT migrate bun run db:validate-import

main_completed=1
