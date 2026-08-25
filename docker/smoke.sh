#!/bin/sh
set -eu

base_url=${1:-"https://${APP_DOMAIN:?APP_DOMAIN must be set}"}
expected_origin=${SMOKE_EXPECTED_ORIGIN:-$base_url}
case "$base_url" in
  https://*|http://*) ;;
  *) echo "base URL must begin with http:// or https://" >&2; exit 2 ;;
esac

python3 - "$base_url" "$expected_origin" <<'PY'
import json
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

raw_base = sys.argv[1].rstrip("/")
raw_expected_origin = sys.argv[2].rstrip("/")
parsed_base = urlparse(raw_base)
parsed_expected_origin = urlparse(raw_expected_origin)
if (
    parsed_base.scheme not in ("http", "https")
    or not parsed_base.hostname
    or parsed_base.username
    or parsed_base.password
    or parsed_base.path not in ("", "/")
    or parsed_base.query
    or parsed_base.fragment
):
    raise SystemExit("base URL must be an HTTP(S) origin")
if (
    parsed_expected_origin.scheme not in ("http", "https")
    or not parsed_expected_origin.hostname
    or parsed_expected_origin.username
    or parsed_expected_origin.password
    or parsed_expected_origin.path not in ("", "/")
    or parsed_expected_origin.query
    or parsed_expected_origin.fragment
):
    raise SystemExit("expected origin must be an HTTP(S) origin")
base = parsed_base._replace(path="", params="", query="", fragment="").geturl().rstrip("/")
expected_origin = parsed_expected_origin._replace(
    path="", params="", query="", fragment=""
).geturl().rstrip("/")

def get(path, expected_type):
    request = urllib.request.Request(base + path, headers={"User-Agent": "homing-smoke/1"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise SystemExit(f"{path}: expected 200, got {response.status}")
            if expected_type not in response.headers.get_content_type():
                raise SystemExit(f"{path}: unexpected content type")
            return response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{path}: HTTP {error.code}")

get("/health/live", "application/json")
get("/health/ready", "application/json")
manifest = json.loads(get("/agent/pkg/manifest.json", "application/json"))
archive = manifest.get("archive")
if manifest.get("package") != "homing-agent-kit" or not isinstance(archive, dict):
    raise SystemExit("agent manifest is incomplete")
if manifest.get("generated_for_origin") != expected_origin:
    raise SystemExit("agent manifest origin does not match the supplied base origin")
archive_path = archive.get("path")
expected_archive_url = f"{expected_origin}/agent/pkg/{archive_path}"
if (
    not isinstance(archive_path, str)
    or not archive_path
    or "/" in archive_path
    or not archive.get("sha256")
    or archive.get("url") != expected_archive_url
):
    raise SystemExit("agent manifest archive URL does not match the supplied base origin")
print("health and agent-kit checks passed")
PY
