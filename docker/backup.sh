#!/bin/sh
set -eu
umask 077

project_dir=${PROJECT_DIR:-"$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"}
env_file=${HOMING_ENV_FILE:-"$project_dir/.env"}
compose_file="$project_dir/compose.yaml"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)

test -f "$env_file" || { echo "missing environment file: $env_file" >&2; exit 1; }
test -f "$compose_file" || { echo "missing Compose file: $compose_file" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
python3 - "$env_file" <<'PY'
import os
import stat
import sys

try:
    info = os.lstat(sys.argv[1])
except OSError:
    raise SystemExit(".env is not accessible")
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
    raise SystemExit(".env must be a regular file owned by this user with mode 0600")
PY

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
backup_namespace=${compose_project_name:-homing-ts}
case "$backup_namespace" in
  *[!A-Za-z0-9_-]*|"")
    echo "COMPOSE_PROJECT_NAME must contain only letters, digits, underscores, and hyphens" >&2
    exit 1
    ;;
esac
backup_dir=${BACKUP_DIR:-"$project_dir/backups/$backup_namespace"}
output="$backup_dir/$backup_namespace-$timestamp-$$.dump.age"
mkdir -p "$backup_dir"
backup_age_recipient=$(read_env_value BACKUP_AGE_RECIPIENT)
backup_rclone_remote=$(read_env_value BACKUP_RCLONE_REMOTE)
backup_retention_days=$(read_env_value BACKUP_RETENTION_DAYS)
test -n "$backup_age_recipient" || { echo "BACKUP_AGE_RECIPIENT is required" >&2; exit 1; }
if [ -z "$backup_retention_days" ]; then backup_retention_days=35; fi
case "$backup_retention_days" in
  *[!0-9]*|"") echo "BACKUP_RETENTION_DAYS must be an integer from 1 to 3650" >&2; exit 1 ;;
esac
if [ "$backup_retention_days" -lt 1 ] || [ "$backup_retention_days" -gt 3650 ]; then
  echo "BACKUP_RETENTION_DAYS must be an integer from 1 to 3650" >&2
  exit 1
fi
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

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

compose() {
  if [ -n "$compose_project_name" ]; then
    docker compose -f "$compose_file" -p "$compose_project_name" --env-file "$env_file" "$@"
  else
    docker compose -f "$compose_file" --env-file "$env_file" "$@"
  fi
}

cd "$project_dir"
compose up --detach --wait db

tmp_dir=$(mktemp -d "$backup_dir/.homing-backup.XXXXXX")
dump_fifo="$tmp_dir/dump"
tmp_output="$tmp_dir/backup.dump.age"

cleanup() {
  rm -rf "$tmp_dir"
  release_lock
}

trap 'cleanup; exit 1' HUP INT TERM
trap cleanup EXIT
mkfifo "$dump_fifo"

# Stream through a FIFO so no plaintext dump reaches disk. Waiting for both
# processes makes pg_dump and age failures observable without relying on
# non-portable pipefail support in /bin/sh.
(
  compose exec --no-TTY db \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump --host=127.0.0.1 --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    >"$dump_fifo"
) &
dump_pid=$!
encrypt_status=0
age --encrypt --recipient "$backup_age_recipient" --output "$tmp_output" <"$dump_fifo" || encrypt_status=$?
dump_status=0
wait "$dump_pid" || dump_status=$?

if [ "$dump_status" -ne 0 ]; then
  echo "pg_dump failed; encrypted backup was not published" >&2
  exit "$dump_status"
fi
if [ "$encrypt_status" -ne 0 ]; then
  echo "age encryption failed; encrypted backup was not published" >&2
  exit "$encrypt_status"
fi
test -s "$tmp_output" || { echo "encrypted backup is empty" >&2; exit 1; }

# Verify the encrypted artifact without requiring the recovery identity on the
# app host. age has already authenticated its recipient argument and completed
# encryption; this additional envelope check catches empty/non-age output while
# never decrypting or materializing the PostgreSQL dump.
if ! awk 'NR == 1 { ok = ($0 == "age-encryption.org/v1") } END { exit(ok ? 0 : 1) }' "$tmp_output"; then
  echo "encryption did not produce a valid age artifact; backup was not published" >&2
  exit 1
fi

# A hard link is an atomic, no-overwrite publication on the same filesystem.
# The PID suffix prevents normal same-second collisions; ln also protects
# against an existing destination if a caller supplies a custom clock.
ln "$tmp_output" "$output" || { echo "backup destination already exists: $output" >&2; exit 1; }
rm "$tmp_output"

if [ -n "$backup_rclone_remote" ]; then
  command -v rclone >/dev/null 2>&1 || { echo "rclone required for configured upload" >&2; exit 1; }
  rclone copyto "$output" "$backup_rclone_remote/$backup_namespace/$(basename "$output")" --immutable
fi

find "$backup_dir" -type f -name "$backup_namespace-*.dump.age" -mtime "+$backup_retention_days" -delete
printf '%s\n' "$output"
