#!/usr/bin/env python3
"""Manifest-driven local removal for Homing agent kit v2."""

import argparse
import json
import os
import shutil
import subprocess
import sys

try:
    from install import (
        InstallError,
        InstallPaths,
        Keychain,
        _owned,
        _refuse_unknown_shipped_files,
        validate_local_manifest,
    )
except ImportError:  # Imported by tests as part of the package.
    from .install import (
        InstallError,
        InstallPaths,
        Keychain,
        _owned,
        _refuse_unknown_shipped_files,
        validate_local_manifest,
    )


class Disconnector:
    """Invoke the narrow client while its Keychain item still exists."""

    def disconnect(self, runtime, connection_id):
        client = runtime / "homing.py"
        if not client.is_file() or not connection_id:
            return "unavailable"
        result = subprocess.run(
            [sys.executable, str(client), "disconnect", "--connection", connection_id],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
        return "disconnected" if result.returncode == 0 else "offline_or_already_disconnected"


class LaunchAgentRemoval:
    def __init__(self, uid=None):
        self.domain = "gui/%s" % (uid if uid is not None else os.getuid())

    def stop(self, plist):
        result = subprocess.run(
            ["launchctl", "bootout", self.domain, str(plist)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode not in (0, 3, 113):
            raise InstallError("could not unload the Homing LaunchAgent")


def _load_manifest(paths):
    if not paths.manifest.exists():
        return None
    try:
        manifest = json.loads(paths.manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InstallError("the v2 install manifest is unreadable; nothing was removed") from exc
    return validate_local_manifest(manifest, paths)


def uninstall(paths=None, keychain=None, launch_agent=None, disconnector=None):
    """Remove only the exact v2 resources. A missing manifest is an idempotent no-op."""
    paths = paths or InstallPaths()
    manifest = _load_manifest(paths)
    if manifest is None:
        return {"status": "not_installed", "disconnect": "not_attempted"}
    keychain = keychain or Keychain()
    launch_agent = launch_agent or LaunchAgentRemoval()
    disconnector = disconnector or Disconnector()
    _refuse_unknown_shipped_files(paths)
    for root in (paths.runtime, paths.state, paths.logs, paths.skill):
        if root.exists() and not _owned(root):
            raise InstallError("refusing to remove unowned path: %s" % root)
    launch_agent.stop(paths.plist)
    disconnect_status = disconnector.disconnect(paths.runtime, manifest.get("connection_id"))
    if paths.plist.exists():
        paths.plist.unlink()
    key = manifest.get("keychain", {})
    if key.get("service") and key.get("account"):
        keychain.delete(key["service"], key["account"])
    # rollback-v1 is intentionally not in this set.
    for root in (paths.runtime, paths.state, paths.logs, paths.skill):
        if root.exists():
            shutil.rmtree(str(root))
    if paths.manifest.exists():
        paths.manifest.unlink()
    try:
        paths.root.rmdir()  # Succeeds only when no rollback bundle or unknown content remains.
    except OSError:
        pass
    return {"status": "removed", "disconnect": disconnect_status}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Remove Homing housing search from this Mac")
    parser.add_argument("--home", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    print(json.dumps(uninstall(InstallPaths(args.home)), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InstallError, OSError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
