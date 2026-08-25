#!/bin/sh
set -eu

base_url=${1:-"https://${APP_DOMAIN:?APP_DOMAIN must be set}"}
case "$base_url" in
  https://*|http://*) ;;
  *) echo "base URL must begin with http:// or https://" >&2; exit 2 ;;
esac

python3 - "$base_url" <<'PY'
import json
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

raw_base = sys.argv[1].rstrip("/")
parsed_base = urlparse(raw_base)
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
base = parsed_base._replace(path="", params="", query="", fragment="").geturl().rstrip("/")

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
if manifest.get("generated_for_origin") != base:
    raise SystemExit("agent manifest origin does not match the supplied base origin")
archive_path = archive.get("path")
expected_archive_url = f"{base}/agent/pkg/{archive_path}"
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
