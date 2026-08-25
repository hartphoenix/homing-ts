#!/bin/sh
set -eu
umask 077

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
project_dir=${PROJECT_DIR:-"$script_dir/.."}
env_file=${HOMING_ENV_FILE:-"$project_dir/.env"}
compose_file="$project_dir/compose.yaml"
backup=${1:-}
if [ -z "$backup" ] || [ ! -f "$backup" ]; then
  echo "usage: $0 /absolute/path/to/homing-ts-<timestamp>.dump.age" >&2
  exit 2
fi
if [ "${RESTORE_CONFIRM:-}" != "YES" ]; then
  echo "restore overwrites application data; set RESTORE_CONFIRM=YES to continue" >&2
  exit 1
fi
test -f "$env_file" || { echo "missing environment file: $env_file" >&2; exit 1; }
test -f "$compose_file" || { echo "missing Compose file: $compose_file" >&2; exit 1; }
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

age_identity_file=${AGE_IDENTITY_FILE:-}
if [ -z "$age_identity_file" ]; then
  age_identity_file=$(awk '
    $0 !~ /^[[:space:]]*#/ && $0 ~ /^[[:space:]]*AGE_IDENTITY_FILE=/ {
      sub(/^[[:space:]]*AGE_IDENTITY_FILE=/, ""); print; exit
    }
  ' "$env_file")
fi
test -n "$age_identity_file" || { echo "AGE_IDENTITY_FILE is required in environment or .env" >&2; exit 1; }
test -r "$age_identity_file" || { echo "identity file is not readable" >&2; exit 1; }

python3 - "$env_file" "$age_identity_file" <<'PY'
import os
import stat
import sys

for path, label in zip(sys.argv[1:], (".env", "recovery identity")):
    try:
        info = os.lstat(path)
    except OSError:
        raise SystemExit(f"{label} is not accessible")
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise SystemExit(f"{label} must be a regular file owned by this user with mode 0600")
PY

# Backup and restore are mutually exclusive. Refuse a stale lock rather than
# risking two operations racing over the same Compose project and database.
lock_dir=${HOMING_OPS_LOCK_DIR:-"$project_dir/.homing-ops.lock"}
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "another Homing backup or restore is already running" >&2
  exit 1
fi
lock_owned=1
release_lock() {
  if [ "$lock_owned" -eq 1 ]; then rmdir "$lock_dir" 2>/dev/null || true; fi
}
trap release_lock EXIT HUP INT TERM

read_env_value() {
  key=$1
  awk -v key="$key" '
    $0 !~ /^[[:space:]]*#/ && $0 ~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=/ {
      line=$0
      sub(/^[[:space:]]*/, "", line)
      name=line
      sub(/=.*/, "", name)
      if (name == key) { sub(/^[^=]*=/, "", line); print line; exit }
    }
  ' "$env_file"
}

compose_project_name=${COMPOSE_PROJECT_NAME:-$(read_env_value COMPOSE_PROJECT_NAME)}

compose() {
  if [ -n "$compose_project_name" ]; then
    docker compose -f "$compose_file" -p "$compose_project_name" --env-file "$env_file" "$@"
  else
    docker compose -f "$compose_file" --env-file "$env_file" "$@"
  fi
}

run_archive_checker() {
  fifo=$1
  shift
  if [ -n "$compose_project_name" ]; then
    python3 "$script_dir/stream_archive.py" "$fifo" \
      docker compose -f "$compose_file" -p "$compose_project_name" --env-file "$env_file" \
      exec --no-TTY db "$@"
  else
    python3 "$script_dir/stream_archive.py" "$fifo" \
      docker compose -f "$compose_file" --env-file "$env_file" exec --no-TTY db "$@"
  fi
}

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/homing-restore.XXXXXX")
verify_fifo="$tmp_dir/verify"
restore_fifo="$tmp_dir/dump"
cleanup() {
  rm -rf "$tmp_dir"
  release_lock
}
trap 'cleanup; exit 1' HUP INT TERM
trap cleanup EXIT
mkfifo "$verify_fifo" "$restore_fifo"

cd "$project_dir"
compose up --detach --wait db

# Verify the archive before stopping public traffic. Decryption and inventory
# inspection stream through a FIFO and never write plaintext to disk.
(
  age --decrypt --identity "$age_identity_file" "$backup" >"$verify_fifo"
) &
verify_pid=$!
inventory_status=0
run_archive_checker "$verify_fifo" pg_restore --list || inventory_status=$?
verify_status=0
wait "$verify_pid" || verify_status=$?
if [ "$verify_status" -ne 0 ] || [ "$inventory_status" -ne 0 ]; then
  echo "backup verification failed; public services were not stopped" >&2
  exit 1
fi

compose stop web caddy

# Objects absent from a custom-format archive survive pg_restore --clean.
# Recreate the target so this is a true snapshot replacement.
compose exec --no-TTY db sh -c '
  case "$POSTGRES_DB" in
    ""|postgres|template0|template1) echo "refusing to replace reserved database" >&2; exit 1 ;;
  esac
  export PGPASSWORD="$POSTGRES_PASSWORD"
  dropdb --force --host=127.0.0.1 --username="$POSTGRES_USER" -- "$POSTGRES_DB"
  createdb --host=127.0.0.1 --username="$POSTGRES_USER" --owner="$POSTGRES_USER" --template=template0 -- "$POSTGRES_DB"
'
(
  age --decrypt --identity "$age_identity_file" "$backup" >"$restore_fifo"
) &
decrypt_pid=$!
restore_status=0
run_archive_checker "$restore_fifo" \
  sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_restore --host=127.0.0.1 --single-transaction --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  || restore_status=$?
decrypt_status=0
wait "$decrypt_pid" || decrypt_status=$?
if [ "$decrypt_status" -ne 0 ] || [ "$restore_status" -ne 0 ]; then
  echo "restore failed; replacement web and Caddy remain stopped" >&2
  exit 1
fi
# The restore creates objects as the database admin because archive ownership
# is intentionally ignored. Reassign those objects before migrations, then use
# only the migration role for schema changes. Provisioning is idempotent.
compose run --rm --no-deps provision
compose run --rm --no-deps migrate
echo "restore completed; web and Caddy remain stopped for explicit private verification" >&2
