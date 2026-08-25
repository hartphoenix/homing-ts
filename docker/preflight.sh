#!/bin/sh
set -eu
umask 077

project_dir=${PROJECT_DIR:-"$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"}
env_file=${1:-"$project_dir/.env"}
test -f "$env_file" || { echo "missing environment file: $env_file" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }

python3 - "$env_file" <<'PY'
import os
import stat
import sys

try:
    info = os.lstat(sys.argv[1])
except OSError:
    raise SystemExit("environment file is not accessible")
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

setting() {
  key=$1
  case "$key" in
    APP_DOMAIN) printf '%s\n' "${APP_DOMAIN:-$(read_env_value APP_DOMAIN)}" ;;
    PUBLIC_ORIGIN) printf '%s\n' "${PUBLIC_ORIGIN:-$(read_env_value PUBLIC_ORIGIN)}" ;;
    HOMING_IMAGE) printf '%s\n' "${HOMING_IMAGE:-$(read_env_value HOMING_IMAGE)}" ;;
    POSTGRES_IMAGE) printf '%s\n' "${POSTGRES_IMAGE:-$(read_env_value POSTGRES_IMAGE)}" ;;
    CADDY_IMAGE) printf '%s\n' "${CADDY_IMAGE:-$(read_env_value CADDY_IMAGE)}" ;;
    DATABASE_URL) printf '%s\n' "${DATABASE_URL:-$(read_env_value DATABASE_URL)}" ;;
    DATABASE_ADMIN_URL) printf '%s\n' "${DATABASE_ADMIN_URL:-$(read_env_value DATABASE_ADMIN_URL)}" ;;
    DATABASE_MIGRATION_URL) printf '%s\n' "${DATABASE_MIGRATION_URL:-$(read_env_value DATABASE_MIGRATION_URL)}" ;;
    AUTH_THROTTLE_KEY) printf '%s\n' "${AUTH_THROTTLE_KEY:-$(read_env_value AUTH_THROTTLE_KEY)}" ;;
    POSTGRES_DB) printf '%s\n' "${POSTGRES_DB:-$(read_env_value POSTGRES_DB)}" ;;
    POSTGRES_USER) printf '%s\n' "${POSTGRES_USER:-$(read_env_value POSTGRES_USER)}" ;;
    POSTGRES_PASSWORD) printf '%s\n' "${POSTGRES_PASSWORD:-$(read_env_value POSTGRES_PASSWORD)}" ;;
    POSTGRES_APP_USER) printf '%s\n' "${POSTGRES_APP_USER:-$(read_env_value POSTGRES_APP_USER)}" ;;
    POSTGRES_APP_PASSWORD) printf '%s\n' "${POSTGRES_APP_PASSWORD:-$(read_env_value POSTGRES_APP_PASSWORD)}" ;;
    POSTGRES_MIGRATION_USER) printf '%s\n' "${POSTGRES_MIGRATION_USER:-$(read_env_value POSTGRES_MIGRATION_USER)}" ;;
    POSTGRES_MIGRATION_PASSWORD) printf '%s\n' "${POSTGRES_MIGRATION_PASSWORD:-$(read_env_value POSTGRES_MIGRATION_PASSWORD)}" ;;
    BACKUP_AGE_RECIPIENT) printf '%s\n' "${BACKUP_AGE_RECIPIENT:-$(read_env_value BACKUP_AGE_RECIPIENT)}" ;;
    BACKUP_AGE_IDENTITY_FILE) printf '%s\n' "${BACKUP_AGE_IDENTITY_FILE:-$(read_env_value BACKUP_AGE_IDENTITY_FILE)}" ;;
    AGE_IDENTITY_FILE) printf '%s\n' "${AGE_IDENTITY_FILE:-$(read_env_value AGE_IDENTITY_FILE)}" ;;
    BACKUP_RETENTION_DAYS) printf '%s\n' "${BACKUP_RETENTION_DAYS:-$(read_env_value BACKUP_RETENTION_DAYS)}" ;;
    HOMING_DEMO_ACCOUNTS) printf '%s\n' "${HOMING_DEMO_ACCOUNTS:-$(read_env_value HOMING_DEMO_ACCOUNTS)}" ;;
    *) echo "unsupported setting: $key" >&2; exit 2 ;;
  esac
}

failures=0
require_value() {
  name=$1
  value=$2
  if [ -z "$value" ]; then
    echo "$name is required" >&2
    failures=$((failures + 1))
  fi
}

app_domain=$(setting APP_DOMAIN)
public_origin=$(setting PUBLIC_ORIGIN)
homing_image=$(setting HOMING_IMAGE)
postgres_image=$(setting POSTGRES_IMAGE)
caddy_image=$(setting CADDY_IMAGE)
database_url=$(setting DATABASE_URL)
database_admin_url=$(setting DATABASE_ADMIN_URL)
database_migration_url=$(setting DATABASE_MIGRATION_URL)
auth_throttle_key=$(setting AUTH_THROTTLE_KEY)
postgres_db=$(setting POSTGRES_DB)
postgres_user=$(setting POSTGRES_USER)
postgres_password=$(setting POSTGRES_PASSWORD)
postgres_app_user=$(setting POSTGRES_APP_USER)
postgres_app_password=$(setting POSTGRES_APP_PASSWORD)
postgres_migration_user=$(setting POSTGRES_MIGRATION_USER)
postgres_migration_password=$(setting POSTGRES_MIGRATION_PASSWORD)
backup_recipient=$(setting BACKUP_AGE_RECIPIENT)
backup_identity=$(setting BACKUP_AGE_IDENTITY_FILE)
[ -n "$backup_identity" ] || backup_identity=$(setting AGE_IDENTITY_FILE)
backup_retention_days=$(setting BACKUP_RETENTION_DAYS)
demo_accounts=$(setting HOMING_DEMO_ACCOUNTS)

require_value APP_DOMAIN "$app_domain"
require_value PUBLIC_ORIGIN "$public_origin"
require_value HOMING_IMAGE "$homing_image"
require_value POSTGRES_IMAGE "$postgres_image"
require_value CADDY_IMAGE "$caddy_image"
require_value DATABASE_URL "$database_url"
require_value DATABASE_ADMIN_URL "$database_admin_url"
require_value DATABASE_MIGRATION_URL "$database_migration_url"
require_value AUTH_THROTTLE_KEY "$auth_throttle_key"
require_value POSTGRES_DB "$postgres_db"
require_value POSTGRES_USER "$postgres_user"
require_value POSTGRES_PASSWORD "$postgres_password"
require_value POSTGRES_APP_USER "$postgres_app_user"
require_value POSTGRES_APP_PASSWORD "$postgres_app_password"
require_value POSTGRES_MIGRATION_USER "$postgres_migration_user"
require_value POSTGRES_MIGRATION_PASSWORD "$postgres_migration_password"
require_value BACKUP_AGE_RECIPIENT "$backup_recipient"

if [ "${#auth_throttle_key}" -lt 32 ]; then
  echo "AUTH_THROTTLE_KEY must be at least 32 characters" >&2
  failures=$((failures + 1))
fi
if [ "$demo_accounts" = "1" ]; then
  echo "HOMING_DEMO_ACCOUNTS=1 is forbidden by the production preflight" >&2
  failures=$((failures + 1))
fi

if [ -n "$backup_identity" ]; then
  if [ ! -r "$backup_identity" ]; then
    echo "configured identity file is not readable" >&2
    failures=$((failures + 1))
  else
    python3 - "$backup_identity" <<'PY' || failures=$((failures + 1))
import os
import stat
import sys

try:
    info = os.lstat(sys.argv[1])
except OSError:
    raise SystemExit("configured identity file is not accessible")
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
    raise SystemExit("configured identity file must be a regular file owned by this user with mode 0600")
PY
  fi
fi

if [ -n "$backup_retention_days" ]; then
  case "$backup_retention_days" in
    *[!0-9]*)
      echo "BACKUP_RETENTION_DAYS must be an integer from 1 to 3650" >&2
      failures=$((failures + 1))
      ;;
    *)
      if [ "$backup_retention_days" -lt 1 ] || [ "$backup_retention_days" -gt 3650 ]; then
        echo "BACKUP_RETENTION_DAYS must be an integer from 1 to 3650" >&2
        failures=$((failures + 1))
      fi
      ;;
  esac
fi

PREFLIGHT_APP_DOMAIN="$app_domain" \
PREFLIGHT_PUBLIC_ORIGIN="$public_origin" \
PREFLIGHT_HOMING_IMAGE="$homing_image" \
PREFLIGHT_POSTGRES_IMAGE="$postgres_image" \
PREFLIGHT_CADDY_IMAGE="$caddy_image" \
PREFLIGHT_DATABASE_URL="$database_url" \
PREFLIGHT_DATABASE_ADMIN_URL="$database_admin_url" \
PREFLIGHT_DATABASE_MIGRATION_URL="$database_migration_url" \
PREFLIGHT_POSTGRES_DB="$postgres_db" \
PREFLIGHT_POSTGRES_USER="$postgres_user" \
PREFLIGHT_POSTGRES_PASSWORD="$postgres_password" \
PREFLIGHT_POSTGRES_APP_USER="$postgres_app_user" \
PREFLIGHT_POSTGRES_APP_PASSWORD="$postgres_app_password" \
PREFLIGHT_POSTGRES_MIGRATION_USER="$postgres_migration_user" \
PREFLIGHT_POSTGRES_MIGRATION_PASSWORD="$postgres_migration_password" \
python3 - <<'PY' || failures=$((failures + 1))
import os
import re
from urllib.parse import unquote, urlparse

app_domain = os.environ["PREFLIGHT_APP_DOMAIN"]
public_origin = os.environ["PREFLIGHT_PUBLIC_ORIGIN"]
images = {
    "HOMING_IMAGE": os.environ["PREFLIGHT_HOMING_IMAGE"],
    "POSTGRES_IMAGE": os.environ["PREFLIGHT_POSTGRES_IMAGE"],
    "CADDY_IMAGE": os.environ["PREFLIGHT_CADDY_IMAGE"],
}
database_url = os.environ["PREFLIGHT_DATABASE_URL"]
database_admin_url = os.environ["PREFLIGHT_DATABASE_ADMIN_URL"]
database_migration_url = os.environ["PREFLIGHT_DATABASE_MIGRATION_URL"]
postgres_db = os.environ["PREFLIGHT_POSTGRES_DB"]
postgres_user = os.environ["PREFLIGHT_POSTGRES_USER"]
postgres_password = os.environ["PREFLIGHT_POSTGRES_PASSWORD"]
postgres_app_user = os.environ["PREFLIGHT_POSTGRES_APP_USER"]
postgres_app_password = os.environ["PREFLIGHT_POSTGRES_APP_PASSWORD"]
postgres_migration_user = os.environ["PREFLIGHT_POSTGRES_MIGRATION_USER"]
postgres_migration_password = os.environ["PREFLIGHT_POSTGRES_MIGRATION_PASSWORD"]

if not re.fullmatch(r"(?:[^@\s]+@)?sha256:[0-9a-f]{64}", images["HOMING_IMAGE"]):
    raise SystemExit(
        "HOMING_IMAGE must be a local content-addressed image ID or a registry digest"
    )
for label in ("POSTGRES_IMAGE", "CADDY_IMAGE"):
    if not re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", images[label]):
        raise SystemExit(
            f"{label} must be an immutable registry reference ending in @sha256:<64 lowercase hex>"
        )

if "://" in app_domain or "/" in app_domain or any(char.isspace() for char in app_domain):
    raise SystemExit("APP_DOMAIN must be a bare hostname, not a URL or path")
if not app_domain or "." not in app_domain:
    raise SystemExit("APP_DOMAIN must be a non-empty public hostname")

try:
    parsed = urlparse(public_origin)
    database = urlparse(database_url)
    database.port
    parsed.port
except ValueError:
    raise SystemExit("PUBLIC_ORIGIN or a database URL is malformed")

if (
    parsed.scheme != "https"
    or not parsed.hostname
    or parsed.username
    or parsed.password
    or parsed.path not in ("", "/")
    or parsed.query
    or parsed.fragment
    or parsed.port not in (None, 443)
):
    raise SystemExit("PUBLIC_ORIGIN must be a bare HTTPS origin")
if parsed.hostname != app_domain:
    raise SystemExit("APP_DOMAIN must exactly match the PUBLIC_ORIGIN hostname")
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", postgres_db):
    raise SystemExit("POSTGRES_DB must be a safe PostgreSQL identifier")
if postgres_db in ("postgres", "template0", "template1"):
    raise SystemExit("POSTGRES_DB must not be a reserved maintenance database")

def check_database_url(value, expected_user, expected_password, label):
    try:
        parsed_url = urlparse(value)
        parsed_url.port
    except ValueError:
        raise SystemExit(f"{label} is malformed")
    if (
        parsed_url.scheme not in ("postgres", "postgresql")
        or parsed_url.hostname != "db"
        or parsed_url.username is None
        or parsed_url.password is None
        or unquote(parsed_url.username) != expected_user
        or unquote(parsed_url.password) != expected_password
        or unquote(parsed_url.path.lstrip("/")) != postgres_db
        or parsed_url.path.count("/") != 1
    ):
        raise SystemExit(f"{label} must bind its configured role, password, database, and host db")

check_database_url(database_admin_url, postgres_user, postgres_password, "DATABASE_ADMIN_URL")
check_database_url(
    database_migration_url,
    postgres_migration_user,
    postgres_migration_password,
    "DATABASE_MIGRATION_URL",
)
check_database_url(database_url, postgres_app_user, postgres_app_password, "DATABASE_URL")
if len({postgres_user, postgres_migration_user, postgres_app_user}) != 3:
    raise SystemExit("admin, migration, and runtime database roles must be distinct")
PY

if [ "$failures" -ne 0 ]; then
  echo "production preflight failed ($failures issue(s)); no services were started" >&2
  exit 1
fi

echo "production preflight passed"
