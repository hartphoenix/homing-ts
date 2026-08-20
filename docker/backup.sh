#!/bin/sh
set -eu
umask 077

project_dir=${PROJECT_DIR:-"$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"}
backup_dir=${BACKUP_DIR:-"$project_dir/backups"}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$backup_dir/homing-ts-$timestamp.dump.age"
mkdir -p "$backup_dir"

test -f "$project_dir/.env" || { echo "missing .env" >&2; exit 1; }

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
  ' "$project_dir/.env"
}

backup_age_recipient=$(read_env_value BACKUP_AGE_RECIPIENT)
backup_rclone_remote=$(read_env_value BACKUP_RCLONE_REMOTE)
backup_retention_days=$(read_env_value BACKUP_RETENTION_DAYS)
test -n "$backup_age_recipient" || { echo "BACKUP_AGE_RECIPIENT is required" >&2; exit 1; }
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }

cd "$project_dir"
docker compose --env-file .env up --detach --wait db

# The database dump is encrypted while streaming. No plaintext dump reaches disk.
docker compose --env-file .env exec --no-TTY db \
  sh -c 'exec pg_dump --format=custom --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | age --encrypt --recipient "$backup_age_recipient" --output "$output"

if [ -n "$backup_rclone_remote" ]; then
  command -v rclone >/dev/null 2>&1 || { echo "rclone required for configured upload" >&2; exit 1; }
  rclone copyto "$output" "$backup_rclone_remote/$(basename "$output")" --immutable
fi

find "$backup_dir" -type f -name 'homing-ts-*.dump.age' \
  -mtime "+${backup_retention_days:-35}" -delete
printf '%s\n' "$output"
