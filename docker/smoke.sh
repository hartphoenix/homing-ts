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

base = sys.argv[1].rstrip("/")

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
if manifest.get("package") != "homing-agent-kit" or not manifest.get("archive", {}).get("sha256"):
    raise SystemExit("agent manifest is incomplete")
print("health and agent-kit checks passed")
PY
