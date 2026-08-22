#!/usr/bin/env python3
"""Initialize or remove one verified temporary Homing setup workspace.

This script only operates on a direct child of the platform temporary directory
whose name starts with ``homing-agent-kit-``. ``--init`` records the verified
package manifest before setup begins. ``--finalize`` requires the durable install
manifest and removes that exact workspace after setup succeeds. ``--discard`` is
the failure-path equivalent when no completed install is being claimed.
"""

import argparse
import datetime
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import uuid


EXIT_OK = 0
EXIT_USAGE = 64
EXIT_REFUSED = 73
EXIT_REMOVE = 74
PACKAGE = "homing-agent-kit"
MARKER = ".homing-agent-kit-ephemeral.json"
PREFIX = "homing-agent-kit-"


class Refuse(Exception):
    pass


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path, label):
    try:
        with open(path, "rb") as handle:
            value = json.loads(handle.read().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise Refuse("I could not read the %s at %s (%s)." % (label, path, exc))
    if not isinstance(value, dict):
        raise Refuse("The %s at %s is not a JSON object." % (label, path))
    return value


def guarded_root(value):
    if not value or not os.path.isabs(value):
        raise Refuse("The package root must be an absolute path.")
    absolute = os.path.abspath(value)
    real = os.path.realpath(absolute)
    temp = os.path.realpath(tempfile.gettempdir())
    if os.path.islink(absolute):
        raise Refuse("The package root may not be a symlink.")
    if os.path.dirname(real) != temp or not os.path.basename(real).startswith(PREFIX):
        raise Refuse(
            "The package root must be a direct child of %s named %s..." % (temp, PREFIX)
        )
    if real in (temp, os.path.dirname(temp), os.path.expanduser("~"), os.path.abspath(os.sep)):
        raise Refuse("The package root is too broad to remove.")
    if not os.path.isdir(real):
        raise Refuse("The package root does not exist: %s" % real)
    return real


def package_path(root, relative):
    if not isinstance(relative, str) or not relative or relative.startswith(("/", "\\")):
        raise Refuse("The package manifest contains an unsafe path.")
    normalized = os.path.normpath(relative.replace("/", os.sep))
    if normalized in (".", "..") or normalized.startswith(".." + os.sep):
        raise Refuse("The package manifest contains an unsafe path: %s" % relative)
    path = os.path.join(root, normalized)
    try:
        inside = os.path.commonpath([root, os.path.abspath(path)]) == root
    except ValueError:
        inside = False
    if not inside:
        raise Refuse("The package manifest escapes its workspace: %s" % relative)
    return path


def regular_file(path, label):
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise Refuse("The %s is missing: %s (%s)." % (label, path, exc))
    if (not stat.S_ISREG(info.st_mode) or os.path.islink(path) or
            getattr(info, "st_nlink", 1) != 1):
        raise Refuse("The %s is not a regular file: %s" % (label, path))


def verify_package(root, manifest_path):
    manifest_real = os.path.realpath(manifest_path)
    if os.path.dirname(manifest_real) != root or os.path.basename(manifest_real) != "manifest.json":
        raise Refuse("The public manifest must be <package-root>/manifest.json.")
    regular_file(manifest_real, "public manifest")
    manifest = load_json(manifest_real, "public manifest")
    if manifest.get("package") != PACKAGE:
        raise Refuse("The public manifest is not for %s." % PACKAGE)
    version = manifest.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise Refuse("The public manifest has no valid package version.")
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise Refuse("The public manifest has no files.")
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise Refuse("The public manifest contains a malformed file entry.")
        relative = entry.get("path")
        if relative in seen:
            raise Refuse("The public manifest repeats %s." % relative)
        seen.add(relative)
        path = package_path(root, relative)
        regular_file(path, "package member")
        if os.path.getsize(path) != entry.get("bytes"):
            raise Refuse("The package member has the wrong size: %s" % relative)
        if sha256_file(path) != entry.get("sha256"):
            raise Refuse("The package member has the wrong digest: %s" % relative)
        try:
            with open(path, "rb") as handle:
                lines = handle.read().decode("utf-8").splitlines()
        except UnicodeDecodeError:
            raise Refuse("The package member is not UTF-8: %s" % relative)
        if len(lines) != entry.get("lines"):
            raise Refuse("The package member has the wrong line count: %s" % relative)
        if entry.get("first_line") != (lines[0] if lines else ""):
            raise Refuse("The package member has the wrong first line: %s" % relative)
        if entry.get("last_line") != (lines[-1] if lines else ""):
            raise Refuse("The package member has the wrong last line: %s" % relative)
    required = {"SETUP.md", "VERSION", "scripts/finalize.py"}
    if not required.issubset(seen):
        raise Refuse("The package is incomplete: %s" % ", ".join(sorted(required - seen)))
    version_path = package_path(root, "VERSION")
    try:
        with open(version_path, "r", encoding="utf-8") as handle:
            disk_version = int(handle.read().strip())
    except (OSError, UnicodeDecodeError, ValueError):
        raise Refuse("VERSION is not one integer.")
    if disk_version != version:
        raise Refuse("VERSION does not match the public manifest.")
    archive = manifest.get("archive")
    if not isinstance(archive, dict):
        raise Refuse("The public manifest has no archive record.")
    archive_path = package_path(root, archive.get("path"))
    if os.path.exists(archive_path):
        regular_file(archive_path, "downloaded archive")
        if os.path.getsize(archive_path) != archive.get("bytes"):
            raise Refuse("The downloaded archive has the wrong size.")
        if sha256_file(archive_path) != archive.get("sha256"):
            raise Refuse("The downloaded archive has the wrong digest.")
    return manifest, sha256_file(manifest_real)


def marker_path(root):
    return os.path.join(root, MARKER)


def initialize(root, manifest_path):
    manifest, manifest_sha = verify_package(root, manifest_path)
    marker = marker_path(root)
    record = {
        "schema": 1,
        "package": PACKAGE,
        "version": manifest["version"],
        "root": root,
        "manifest_sha256": manifest_sha,
        "initialized_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    if os.path.exists(marker):
        current = load_json(marker, "workspace marker")
        comparable = {key: current.get(key) for key in record if key != "initialized_at"}
        expected = {key: value for key, value in record.items() if key != "initialized_at"}
        if comparable != expected:
            raise Refuse("The existing workspace marker does not match this package.")
        print("The verified temporary setup workspace was already initialized.")
        return
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(marker, flags, 0o600)
    try:
        os.write(descriptor, (json.dumps(record, sort_keys=True) + "\n").encode("utf-8"))
    finally:
        os.close(descriptor)
    print("Initialized the verified temporary setup workspace.")


def verify_marker(root, manifest_path, manifest_sha, version):
    marker = marker_path(root)
    regular_file(marker, "workspace marker")
    record = load_json(marker, "workspace marker")
    expected = {
        "schema": 1,
        "package": PACKAGE,
        "version": version,
        "root": root,
        "manifest_sha256": manifest_sha,
    }
    for key, value in expected.items():
        if record.get(key) != value:
            raise Refuse("The workspace marker does not match the verified package (%s)." % key)
    if os.path.realpath(manifest_path) != os.path.join(root, "manifest.json"):
        raise Refuse("The public manifest moved after initialization.")


def installed_authority(manifest):
    marker_paths = {str(entry.get("marker") or "") for entry in manifest.get("owned_dirs") or []
                    if isinstance(entry, dict)}
    files = [entry for entry in manifest.get("files") or []
             if isinstance(entry, dict) and entry.get("path") not in marker_paths]
    payload = {
        "schema": manifest.get("schema"),
        "package_version": manifest.get("package_version"),
        "install_id": manifest.get("install_id"),
        "origin": manifest.get("origin"),
        "paths": manifest.get("paths"),
        "runner": manifest.get("runner"),
        "runtime_prompt": manifest.get("runtime_prompt"),
        "interactive_skill": manifest.get("interactive_skill"),
        "files": files,
        "links": manifest.get("links"),
        "owned_dirs": manifest.get("owned_dirs"),
        "scheduler": manifest.get("scheduler"),
        "secret_store": manifest.get("secret_store"),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def verify_install_manifest(path, root, version):
    if not path or not os.path.isabs(path):
        raise Refuse("--finalize requires an absolute installed manifest path.")
    real = os.path.realpath(path)
    try:
        inside_package = os.path.commonpath([root, real]) == root
    except ValueError:
        inside_package = False
    if inside_package:
        raise Refuse("The installed manifest may not live in the temporary package.")
    regular_file(real, "installed manifest")
    manifest = load_json(real, "installed manifest")
    if manifest.get("schema") != 1 or manifest.get("package_version") != version:
        raise Refuse("The installed manifest does not record this package version.")
    try:
        uuid.UUID(str(manifest.get("install_id") or ""))
    except (ValueError, TypeError, AttributeError):
        raise Refuse("The installed manifest has no valid ownership id.")
    paths = manifest.get("paths")
    if not isinstance(paths, dict):
        raise Refuse("The installed manifest has no durable path record.")
    state = paths.get("state")
    if (not isinstance(state, str) or not os.path.isabs(state) or
            os.path.realpath(os.path.dirname(real)) != os.path.realpath(state) or
            os.path.basename(real) != "install-manifest.json"):
        raise Refuse("The installed manifest is not in its recorded state directory.")
    if os.path.islink(path) or os.lstat(real).st_nlink != 1:
        raise Refuse("The installed manifest was linked or substituted.")
    owned = manifest.get("owned_dirs")
    if not isinstance(owned, list) or not owned:
        raise Refuse("The installed manifest has no ownership records.")
    state_owner = False
    authority = installed_authority(manifest)
    for entry in owned:
        if not isinstance(entry, dict):
            raise Refuse("The installed manifest has a malformed ownership record.")
        directory = entry.get("path")
        role = entry.get("role")
        marker = entry.get("marker")
        if (not isinstance(directory, str) or not os.path.isabs(directory) or
                marker != os.path.join(directory, ".homing-install-owner.json") or
                os.path.islink(directory) or not os.path.isdir(directory)):
            raise Refuse("An installed ownership record is unsafe.")
        regular_file(marker, "install ownership marker")
        marker_value = load_json(marker, "install ownership marker")
        expected = {
            "schema": 1,
            "package": PACKAGE,
            "install_id": manifest["install_id"],
            "role": role,
            "path": directory,
            "manifest_authority": authority,
        }
        if any(marker_value.get(key) != value for key, value in expected.items()):
            raise Refuse("An install ownership marker does not match the manifest.")
        state_owner = state_owner or (role == "state" and os.path.realpath(directory) ==
                                      os.path.realpath(state))
    if not state_owner:
        raise Refuse("The installed state directory has no matching ownership marker.")
    runner = manifest.get("runner")
    if not isinstance(runner, str) or not os.path.isabs(runner) or not os.path.isfile(runner):
        raise Refuse("The installed manifest does not name a durable worker.")
    try:
        runner_inside = os.path.commonpath([root, os.path.realpath(runner)]) == root
    except ValueError:
        runner_inside = False
    if runner_inside:
        raise Refuse("The durable worker was written inside the temporary package.")
    runtime_prompt = manifest.get("runtime_prompt")
    if (not isinstance(runtime_prompt, str) or not os.path.isabs(runtime_prompt) or
            not os.path.isfile(runtime_prompt)):
        raise Refuse("The installed manifest does not name its durable runtime prompt.")
    file_records = manifest.get("files")
    if not isinstance(file_records, list):
        raise Refuse("The installed manifest has no exact file records.")
    records = {entry.get("path"): entry for entry in file_records if isinstance(entry, dict)}
    for durable in (runner, runtime_prompt):
        record = records.get(durable)
        if (not record or not isinstance(record.get("sha256"), str) or
                sha256_file(durable) != record["sha256"]):
            raise Refuse("A required durable file does not match the installed manifest: %s"
                         % durable)
    serialized = json.dumps(manifest, sort_keys=True)
    for marker in ("SETUP.md", "finalize.py", "probe.sh", "homing-setup"):
        if marker in serialized:
            raise Refuse("The durable manifest still references setup material: %s" % marker)


def remove_workspace(root, manifest_path, installed_manifest, dry_run):
    manifest, manifest_sha = verify_package(root, manifest_path)
    verify_marker(root, manifest_path, manifest_sha, manifest["version"])
    if installed_manifest:
        verify_install_manifest(installed_manifest, root, manifest["version"])
    if dry_run:
        print("Would remove the verified temporary setup workspace: %s" % root)
        return
    try:
        shutil.rmtree(root)
    except OSError as exc:
        raise Refuse("I could not remove the temporary setup workspace %s (%s)." % (root, exc))
    print("Removed the temporary setup workspace.")


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    action = value.add_mutually_exclusive_group(required=True)
    action.add_argument("--init", action="store_true", help="mark a verified package before setup")
    action.add_argument("--finalize", action="store_true", help="remove it after a verified install")
    action.add_argument("--discard", action="store_true", help="remove it without claiming install success")
    value.add_argument("--package-root", required=True, help="absolute temporary package directory")
    value.add_argument("--manifest", required=True, help="<package-root>/manifest.json")
    value.add_argument("--installed-manifest", help="durable install-manifest.json")
    value.add_argument("--dry-run", action="store_true", help="verify and report without removing")
    return value


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        root = guarded_root(args.package_root)
        if args.init:
            if args.installed_manifest or args.dry_run:
                raise Refuse("--init does not accept --installed-manifest or --dry-run.")
            initialize(root, args.manifest)
        elif args.finalize:
            if not args.installed_manifest:
                raise Refuse("--finalize requires --installed-manifest.")
            remove_workspace(root, args.manifest, args.installed_manifest, args.dry_run)
        else:
            if args.installed_manifest:
                raise Refuse("--discard does not accept --installed-manifest.")
            remove_workspace(root, args.manifest, None, args.dry_run)
        return EXIT_OK
    except Refuse as exc:
        sys.stderr.write("finalize: %s\n" % exc)
        return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main())
