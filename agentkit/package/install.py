#!/usr/bin/env python3
"""Transactional macOS installer for Homing agent kit v2.

The implementation is dependency-free and keeps operating-system calls behind two small
interfaces so temporary-home tests never touch the live Keychain or launchd session.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import uuid
import zipfile

LABEL = "com.hartphoenix.homing.search"
DESCRIPTION = "Homing housing search"
OWNER_MARKER = ".homing-agent-v2-owned"
LOCAL_MANIFEST = "install-manifest.json"
SETUP_WORKSPACE_MARKER = ".homing-agent-setup-workspace"
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024
MAX_MEMBER_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024
MAX_MEMBERS = 64
MAX_ROLLBACK_FILES = 128
MIN_PYTHON = (3, 9)
MIN_CLAUDE = (2, 1, 247)
REQUIRED_CLAUDE_FLAGS = (
    "-p",
    "--safe-mode",
    "--tools",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "--no-session-persistence",
    "--output-format",
    "--json-schema",
    "--model",
    "--max-budget-usd",
    "--settings",
)
CLAUDE_ARGV_TEMPLATE = [
    "claude",
    "-p",
    "--safe-mode",
    "--tools",
    "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "<empty-mcp.json>",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    "<schema>",
    "--model",
    "<pinned-model>",
    "--max-budget-usd",
    "<bound>",
    "--settings",
    "<closed-settings.json>",
]


class InstallError(RuntimeError):
    pass


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_member(name):
    if not name or "\\" in name or name.endswith("/"):
        return None
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        return None
    return path


def _workspace_marker(destination, release_manifest):
    return {
        "schema": 1,
        "kind": "homing-agent-setup-workspace",
        "archive_sha256": release_manifest.get("archive", {}).get("sha256"),
        "files": sorted(entry["path"] for entry in release_manifest.get("files", [])),
    }


def extract_verified(archive_path, release_manifest, destination):
    """Verify and extract exactly the regular files declared by the release manifest."""
    archive_path = Path(archive_path)
    destination = Path(destination)
    archive = release_manifest.get("archive", {})
    if archive_path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise InstallError("archive exceeds the size limit")
    if archive.get("sha256") != sha256_file(archive_path):
        raise InstallError("archive digest does not match the release manifest")
    declared_list = release_manifest.get("files")
    if not isinstance(declared_list, list) or len(declared_list) > MAX_MEMBERS:
        raise InstallError("release manifest has an invalid file list")
    declared = {}
    for entry in declared_list:
        if not isinstance(entry, dict) or _safe_member(entry.get("path")) is None:
            raise InstallError("release manifest contains an unsafe path")
        name = entry["path"]
        if (
            not isinstance(entry.get("bytes"), int)
            or entry["bytes"] < 0
            or entry["bytes"] > MAX_MEMBER_BYTES
            or not isinstance(entry.get("sha256"), str)
            or len(entry["sha256"]) != 64
        ):
            raise InstallError("release manifest contains invalid file metadata")
        if name in declared:
            raise InstallError("release manifest contains a duplicate path")
        declared[name] = entry
    if sum(entry["bytes"] for entry in declared.values()) > MAX_TOTAL_BYTES:
        raise InstallError("declared package content exceeds the size limit")
    destination.mkdir(parents=True, exist_ok=False)
    marker = destination / SETUP_WORKSPACE_MARKER
    marker.write_text(
        json.dumps(_workspace_marker(destination, release_manifest), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.chmod(str(marker), 0o600)
    seen = set()
    with zipfile.ZipFile(str(archive_path), "r") as bundle:
        infos = bundle.infolist()
        if len(infos) > MAX_MEMBERS:
            raise InstallError("archive contains too many members")
        for info in infos:
            path = _safe_member(info.filename)
            mode = info.external_attr >> 16
            if path is None or info.filename in seen:
                raise InstallError("archive contains an unsafe or duplicate member")
            file_type = stat.S_IFMT(mode)
            if stat.S_ISLNK(mode) or (file_type and not stat.S_ISREG(mode)):
                raise InstallError("archive contains a link or special file")
            if info.file_size > MAX_MEMBER_BYTES:
                raise InstallError("archive member exceeds the size limit")
            entry = declared.get(info.filename)
            if entry is None:
                raise InstallError("archive contains an undeclared member")
            data = bundle.read(info)
            if len(data) != entry.get("bytes") or hashlib.sha256(data).hexdigest() != entry.get(
                "sha256"
            ):
                raise InstallError("archive member does not match the release manifest")
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            os.chmod(str(target), 0o644)
            seen.add(info.filename)
    if seen != set(declared):
        raise InstallError("archive is missing a declared member")
    return destination


class InstallPaths:
    def __init__(self, home=None):
        self.home = Path(home or Path.home()).resolve()
        self.root = self.home / "Library/Application Support/Homing Agent"
        self.runtime = self.root / "runtime"
        self.state = self.root / "state"
        self.rollback = self.root / "rollback-v1"
        self.logs = self.home / "Library/Logs/Homing Agent"
        self.plist = self.home / "Library/LaunchAgents" / (LABEL + ".plist")
        self.skill = self.home / ".agents/skills/homing-check"
        self.manifest = self.root / LOCAL_MANIFEST


class Keychain:
    def _run(self, args):
        return subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode

    def exists(self, service, account):
        return self._run(["security", "find-generic-password", "-s", service, "-a", account]) == 0

    def delete(self, service, account):
        code = self._run(["security", "delete-generic-password", "-s", service, "-a", account])
        if code not in (0, 44):
            raise InstallError("could not remove the Homing Keychain item")


class LaunchAgent:
    def __init__(self, uid=None):
        self.domain = "gui/%s" % (uid if uid is not None else os.getuid())

    def stop(self, plist):
        result = subprocess.run(
            ["launchctl", "bootout", self.domain, str(plist)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode not in (0, 3, 113):
            raise InstallError("could not stop the existing Homing job")

    def start(self, plist):
        result = subprocess.run(
            ["launchctl", "bootstrap", self.domain, str(plist)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode:
            raise InstallError("could not start the Homing job")

    def loaded(self):
        return (
            subprocess.run(
                ["launchctl", "print", self.domain + "/" + LABEL],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 0
        )


class ConnectionRevoker:
    """Revoke a just-paired connection through the credential-reading client subprocess."""

    def revoke(self, package, connection, service, account):
        client = Path(package) / "homing.py"
        result = subprocess.run(
            [
                sys.executable,
                str(client),
                "--service",
                service,
                "--account",
                account,
                "disconnect",
                "--connection",
                connection,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            env={"PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
        if result.returncode:
            raise InstallError("the failed install's new Homing connection could not be revoked")


class V1JobInspector:
    def __init__(self, uid=None):
        self.domain = "gui/%s" % (uid if uid is not None else os.getuid())

    def loaded(self, label):
        result = subprocess.run(
            ["launchctl", "print", self.domain + "/" + label],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode == 0:
            return True
        if result.returncode in (3, 113):
            return False
        raise InstallError("could not verify that the recorded v1 job is stopped")


class RetirementRevoker:
    """Revoke through the credential-reading client without exposing the retained v1 key."""

    def revoke(self, client_path, connection, service, account):
        result = subprocess.run(
            [
                sys.executable,
                str(client_path),
                "--service",
                service,
                "--account",
                account,
                "disconnect",
                "--connection",
                connection,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
            env={"PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
        if result.returncode == 0:
            return "revoked"
        try:
            error = json.loads(result.stderr).get("error")
        except (json.JSONDecodeError, AttributeError):
            error = None
        raise InstallError(
            "the recorded v1 connection could not be revoked (%s)" % (error or "client_error")
        )


def launch_agent_bytes(paths, python=sys.executable):
    payload = {
        "Label": LABEL,
        "ProgramArguments": [
            str(Path(python).resolve()),
            str(paths.runtime / "runner.py"),
            "scheduled",
        ],
        "RunAtLoad": True,
        "StartCalendarInterval": {"Hour": 9, "Minute": 0},
        "ProcessType": "Background",
        "StandardOutPath": str(paths.logs / "search.log"),
        "StandardErrorPath": str(paths.logs / "search-error.log"),
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"},
    }
    return plistlib.dumps(payload, fmt=plistlib.FMT_XML, sort_keys=True)


def _mark(root):
    root.mkdir(parents=True, exist_ok=True)
    marker = root / OWNER_MARKER
    marker.write_text(LABEL + "\n", encoding="utf-8")
    os.chmod(str(marker), 0o600)


def _owned(root):
    marker = root / OWNER_MARKER
    try:
        return marker.read_text(encoding="utf-8") == LABEL + "\n"
    except (FileNotFoundError, OSError, UnicodeError):
        return False


def _refuse_unowned(path):
    if path.exists() and not _owned(path):
        raise InstallError("refusing to replace unowned path: %s" % path)


def _refuse_unknown_shipped_files(paths):
    if not (paths.runtime.exists() or paths.skill.exists()):
        return
    if not paths.manifest.is_file():
        raise InstallError("refusing to replace a marked tree without its install manifest")
    local = validate_local_manifest(_read_json(paths.manifest), paths)
    expected = {"runtime": set(), "skill": set()}
    for entry in local["files"]:
        expected[entry["root"]].add(entry["path"])
    for name, root in (("runtime", paths.runtime), ("skill", paths.skill)):
        for child in root.rglob("*"):
            if child.is_symlink():
                raise InstallError("refusing to replace an unknown link: %s" % child)
            if child.is_file() and child.name != OWNER_MARKER:
                relative = child.relative_to(root).as_posix()
                if relative not in expected[name]:
                    raise InstallError("refusing to remove an unknown file: %s" % child)


def _package_entries(package, release_manifest):
    entries = {}
    for entry in release_manifest.get("files", []):
        rel = entry.get("path")
        if _safe_member(rel) is None:
            raise InstallError("release manifest contains an unsafe path")
        if rel in entries:
            raise InstallError("release manifest contains a duplicate path")
        if (
            not isinstance(entry.get("bytes"), int)
            or entry["bytes"] < 0
            or not isinstance(entry.get("sha256"), str)
            or len(entry["sha256"]) != 64
        ):
            raise InstallError("release manifest contains invalid file metadata")
        source = package / rel
        if not source.is_file() or source.is_symlink():
            raise InstallError("package is missing a regular file: %s" % rel)
        if source.stat().st_size != entry.get("bytes") or sha256_file(source) != entry.get(
            "sha256"
        ):
            raise InstallError("package file does not match its manifest: %s" % rel)
        entries[rel] = entry
    required = {
        "VERSION",
        "SETUP.md",
        "install.py",
        "uninstall.py",
        "runner.py",
        "homing.py",
        "selftest.py",
        "homing-check/SKILL.md",
    }
    missing = required - set(entries)
    if missing:
        raise InstallError("package is missing required files: %s" % ", ".join(sorted(missing)))
    return entries


def _workspace_path(workspace):
    path = Path(workspace).expanduser().resolve()
    if not path.is_dir() or path.is_symlink():
        raise InstallError("setup workspace is not a regular directory")
    home = Path.home().resolve()
    protected = {
        Path("/").resolve(),
        home,
        home / "Library",
        home / ".agents",
        home / ".claude",
    }
    if path in protected:
        raise InstallError("refusing to finalize a protected setup workspace")
    for skill_root in (home / ".agents/skills", home / ".claude/skills"):
        if skill_root == path or skill_root in path.parents:
            raise InstallError("refusing to finalize a skill-root setup workspace")
    if any(part in {".git", "iCloud Drive", "Dropbox", "OneDrive", "Google Drive"} for part in path.parts):
        raise InstallError("refusing to finalize a repository or synced setup workspace")
    if any((parent / ".git").is_dir() for parent in (path, *path.parents)):
        raise InstallError("refusing to finalize a repository setup workspace")
    return path


def finalize_setup_workspace(workspace, release_manifest):
    """Delete only a freshly extracted, manifest-verified setup workspace."""
    workspace = _workspace_path(workspace)
    manifest_path = Path(release_manifest).expanduser().resolve()
    if workspace == manifest_path or workspace in manifest_path.parents:
        raise InstallError("release manifest must be outside the setup workspace")
    try:
        release = _read_json(manifest_path)
        marker = _read_json(workspace / SETUP_WORKSPACE_MARKER)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InstallError("setup workspace marker or release manifest is unreadable") from exc
    declared = release.get("files")
    if not isinstance(declared, list) or len(declared) > MAX_MEMBERS:
        raise InstallError("release manifest has an invalid file list")
    expected = {}
    for entry in declared:
        name = entry.get("path") if isinstance(entry, dict) else None
        if _safe_member(name) is None or name in expected:
            raise InstallError("release manifest contains an unsafe or duplicate path")
        if (
            not isinstance(entry.get("bytes"), int)
            or entry["bytes"] < 0
            or entry["bytes"] > MAX_MEMBER_BYTES
            or not isinstance(entry.get("sha256"), str)
            or len(entry["sha256"]) != 64
        ):
            raise InstallError("release manifest contains invalid file metadata")
        expected[name] = entry
    expected_names = set(expected)
    if (
        not isinstance(marker, dict)
        or marker.get("schema") != 1
        or marker.get("kind") != "homing-agent-setup-workspace"
        or marker.get("archive_sha256") != release.get("archive", {}).get("sha256")
        or marker.get("files") != sorted(expected_names)
    ):
        raise InstallError("setup workspace marker does not match its release manifest")
    allowed_files = expected_names | {SETUP_WORKSPACE_MARKER}
    expected_dirs = {
        parent
        for name in expected_names
        for parent in Path(name).parents
        if parent != Path(".")
    }
    actual_files = set()
    actual_dirs = set()
    for child in workspace.rglob("*"):
        relative = child.relative_to(workspace).as_posix()
        if child.is_symlink():
            raise InstallError("setup workspace contains an unexpected link: %s" % relative)
        if child.is_file():
            actual_files.add(relative)
        elif child.is_dir():
            actual_dirs.add(relative)
        else:
            raise InstallError("setup workspace contains an unexpected resource: %s" % relative)
    package_files = actual_files - {SETUP_WORKSPACE_MARKER}
    if not package_files <= expected_names:
        residue = sorted(package_files - expected_names)
        raise InstallError(
            "setup workspace contains unexpected residue: %s" % ", ".join(residue)
        )
    for name in package_files:
        entry = expected[name]
        path = workspace / name
        if path.stat().st_size != entry["bytes"] or sha256_file(path) != entry["sha256"]:
            raise InstallError("setup workspace file does not match its release manifest: %s" % name)
    if SETUP_WORKSPACE_MARKER not in actual_files or not actual_dirs <= {
        path.as_posix() for path in expected_dirs
    }:
        extra_dirs = sorted(actual_dirs - {path.as_posix() for path in expected_dirs})
        raise InstallError(
            "setup workspace contains unexpected residue: %s"
            % ", ".join(extra_dirs or [SETUP_WORKSPACE_MARKER])
        )
    for name in sorted(actual_files, key=lambda value: (value.count("/"), value), reverse=True):
        (workspace / name).unlink()
    for name in sorted(actual_dirs, key=lambda value: (value.count("/"), value), reverse=True):
        (workspace / name).rmdir()
    try:
        workspace.rmdir()
    except OSError:
        residue = sorted(path.relative_to(workspace).as_posix() for path in workspace.rglob("*"))
        return {"status": "residue", "workspace": str(workspace), "residue": residue}
    return {"status": "cleaned", "workspace": str(workspace)}


def _copy_runtime(package, stage, entries):
    _mark(stage)
    for rel in sorted(entries):
        if rel in {"SETUP.md", "index.md", "homing-check/SKILL.md"}:
            continue
        source = package / rel
        target = stage / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(str(source), str(target))
        os.chmod(str(target), 0o755 if rel.endswith(".py") else 0o644)


def _write_skill(package, stage):
    source = package / "homing-check/SKILL.md"
    if not source.is_file():
        raise InstallError("package is missing homing-check/SKILL.md")
    _mark(stage)
    shutil.copyfile(str(source), str(stage / "SKILL.md"))
    os.chmod(str(stage / "SKILL.md"), 0o644)


def _local_manifest(
    paths, release_manifest, connection, service, account, python, claude_qualification
):
    files = []
    for root_name, root in (("runtime", paths.runtime), ("skill", paths.skill)):
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.name != OWNER_MARKER:
                files.append(
                    {
                        "root": root_name,
                        "path": path.relative_to(root).as_posix(),
                        "bytes": path.stat().st_size,
                        "sha256": sha256_file(path),
                        "mode": stat.S_IMODE(path.stat().st_mode),
                    }
                )
    return {
        "schema": 1,
        "kit_version": release_manifest.get("version"),
        "package_sha256": release_manifest.get("archive", {}).get("sha256"),
        "origin": release_manifest.get("generated_for_origin"),
        "description": DESCRIPTION,
        "connection_id": connection,
        "keychain": {"service": service, "account": account},
        "launch_agent": {"label": LABEL, "path": str(paths.plist)},
        "python": str(Path(python).resolve()),
        "claude": {
            "version": claude_qualification["version"],
            "executable": claude_qualification["executable"],
            "argv_template": CLAUDE_ARGV_TEMPLATE,
        },
        "files": files,
        "owned_roots": [str(paths.runtime), str(paths.state), str(paths.logs), str(paths.skill)],
    }


def validate_local_manifest(manifest, paths):
    if not isinstance(manifest, dict) or manifest.get("schema") != 1:
        raise InstallError("the local install manifest has an unsupported schema")
    launch = manifest.get("launch_agent", {})
    if launch.get("label") != LABEL or Path(launch.get("path", "")) != paths.plist:
        raise InstallError("the local install manifest does not own the expected LaunchAgent")
    expected_roots = [str(paths.runtime), str(paths.state), str(paths.logs), str(paths.skill)]
    if manifest.get("owned_roots") != expected_roots:
        raise InstallError("the local install manifest does not own the expected roots")
    seen = set()
    for entry in manifest.get("files", []):
        if (
            not isinstance(entry, dict)
            or entry.get("root") not in ("runtime", "skill")
            or _safe_member(entry.get("path")) is None
        ):
            raise InstallError("the local install manifest contains an unsafe file entry")
        identity = (entry["root"], entry["path"])
        if identity in seen:
            raise InstallError("the local install manifest contains duplicate files")
        seen.add(identity)
    key = manifest.get("keychain", {})
    if not all(isinstance(key.get(name), str) and key[name] for name in ("service", "account")):
        raise InstallError("the local install manifest has incomplete Keychain metadata")
    if not isinstance(manifest.get("connection_id"), str) or not manifest["connection_id"]:
        raise InstallError("the local install manifest has no connection identity")
    origin = manifest.get("origin")
    parsed_origin = urllib.parse.urlsplit(origin) if isinstance(origin, str) else None
    if (
        not parsed_origin
        or parsed_origin.scheme != "https"
        or not parsed_origin.hostname
        or parsed_origin.username is not None
        or parsed_origin.password is not None
        or parsed_origin.path not in ("", "/")
        or parsed_origin.query
        or parsed_origin.fragment
    ):
        raise InstallError("the local install manifest has no HTTPS Homing origin")
    claude = manifest.get("claude", {})
    if (
        not isinstance(claude.get("version"), str)
        or not isinstance(claude.get("executable"), str)
        or claude.get("argv_template") != CLAUDE_ARGV_TEMPLATE
    ):
        raise InstallError("the local install manifest has incomplete Claude qualification")
    return manifest


def _install_transaction(
    package,
    release_manifest,
    connection,
    service,
    account,
    paths=None,
    keychain=None,
    launch_agent=None,
    python=sys.executable,
    claude_qualification=None,
):
    """Install or repair one v2 job. All mutation is rolled back on failure."""
    paths = paths or InstallPaths()
    keychain = keychain or Keychain()
    launch_agent = launch_agent or LaunchAgent()
    package = Path(package).resolve()
    claude_qualification = claude_qualification or qualify_claude()
    if not claude_qualification.get("supported"):
        raise InstallError("Claude Code does not provide the qualified unattended interface")
    entries = _package_entries(package, release_manifest)
    if not keychain.exists(service, account):
        raise InstallError("the expected Homing Keychain item is absent")
    for target in (paths.runtime, paths.state, paths.logs, paths.skill):
        _refuse_unowned(target)
    _refuse_unknown_shipped_files(paths)
    if paths.plist.exists():
        try:
            old_label = plistlib.loads(paths.plist.read_bytes()).get("Label")
        except Exception as exc:
            raise InstallError("refusing to replace an unreadable LaunchAgent") from exc
        if old_label != LABEL:
            raise InstallError("refusing to replace an unowned LaunchAgent")

    paths.root.mkdir(parents=True, exist_ok=True)
    stage_parent = Path(tempfile.mkdtemp(prefix=".homing-v2-stage-", dir=str(paths.root.parent)))
    runtime_stage = stage_parent / "runtime"
    skill_stage = stage_parent / "skill"
    backups = {}
    roots_existed = {paths.state: paths.state.exists(), paths.logs: paths.logs.exists()}
    old_loaded = launch_agent.loaded()
    committed = False
    try:
        _copy_runtime(package, runtime_stage, entries)
        _write_skill(package, skill_stage)
        plist_stage = stage_parent / paths.plist.name
        plist_stage.write_bytes(launch_agent_bytes(paths, python))
        plistlib.loads(plist_stage.read_bytes())
        launch_agent.stop(paths.plist)
        for name, target in (
            ("runtime", paths.runtime),
            ("skill", paths.skill),
            ("plist", paths.plist),
            ("manifest", paths.manifest),
        ):
            if target.exists():
                backup = stage_parent / (name + ".previous")
                target.rename(backup)
                backups[name] = (backup, target)
        paths.runtime.parent.mkdir(parents=True, exist_ok=True)
        paths.skill.parent.mkdir(parents=True, exist_ok=True)
        paths.plist.parent.mkdir(parents=True, exist_ok=True)
        runtime_stage.rename(paths.runtime)
        skill_stage.rename(paths.skill)
        plist_stage.rename(paths.plist)
        _mark(paths.state)
        _mark(paths.logs)
        manifest = _local_manifest(
            paths, release_manifest, connection, service, account, python, claude_qualification
        )
        validate_local_manifest(manifest, paths)
        temp_manifest = paths.root / (LOCAL_MANIFEST + ".new")
        temp_manifest.write_text(
            json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )
        os.chmod(str(temp_manifest), 0o600)
        os.replace(str(temp_manifest), str(paths.manifest))
        launch_agent.start(paths.plist)
        committed = True
        return manifest
    except Exception as original_error:
        try:
            launch_agent.stop(paths.plist)
        except Exception:
            pass
        for target in (paths.plist, paths.skill, paths.runtime):
            if target.exists() and (target.is_file() or _owned(target)):
                if target.is_dir():
                    shutil.rmtree(str(target))
                else:
                    target.unlink()
        if paths.manifest.exists():
            paths.manifest.unlink()
        for _name, (backup, target) in backups.items():
            if backup.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                backup.rename(target)
        for root, existed in roots_existed.items():
            if not existed and root.exists() and _owned(root):
                shutil.rmtree(str(root))
        if old_loaded and paths.plist.exists():
            try:
                launch_agent.start(paths.plist)
            except Exception:
                pass
        raise original_error
    finally:
        if committed:
            for backup, _target in backups.values():
                if backup.is_dir():
                    shutil.rmtree(str(backup))
                elif backup.exists():
                    backup.unlink()
        shutil.rmtree(str(stage_parent), ignore_errors=True)


def install(
    package,
    release_manifest,
    connection,
    service,
    account,
    paths=None,
    keychain=None,
    launch_agent=None,
    python=sys.executable,
    claude_qualification=None,
    revoker=None,
    new_connection=None,
):
    """Install transaction plus mandatory cleanup of a newly paired failed connection."""
    paths = paths or InstallPaths()
    keychain = keychain or Keychain()
    if new_connection is None:
        new_connection = not paths.manifest.exists()
    try:
        return _install_transaction(
            package,
            release_manifest,
            connection,
            service,
            account,
            paths=paths,
            keychain=keychain,
            launch_agent=launch_agent,
            python=python,
            claude_qualification=claude_qualification,
        )
    except Exception as original_error:
        if new_connection:
            try:
                (revoker or ConnectionRevoker()).revoke(package, connection, service, account)
                keychain.delete(service, account)
            except Exception as cleanup_error:
                raise InstallError(
                    "installation failed; the new Homing connection also needs cleanup"
                ) from cleanup_error
        raise original_error


def drift(manifest, paths=None):
    paths = paths or InstallPaths()
    validate_local_manifest(manifest, paths)
    roots = {"runtime": paths.runtime, "skill": paths.skill}
    problems = []
    for entry in manifest.get("files", []):
        path = roots.get(entry.get("root"), Path("/__invalid__")) / entry.get("path", "")
        if (
            not path.is_file()
            or path.stat().st_size != entry.get("bytes")
            or sha256_file(path) != entry.get("sha256")
        ):
            problems.append("drifted:%s:%s" % (entry.get("root"), entry.get("path")))
    if not paths.plist.is_file():
        problems.append("missing:launch-agent")
    return problems


def status(paths=None, keychain=None, launch_agent=None):
    paths = paths or InstallPaths()
    if not paths.manifest.is_file():
        return {"status": "not_installed", "job": LABEL}
    try:
        manifest = json.loads(paths.manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise InstallError("the local install manifest is unreadable") from exc
    validate_local_manifest(manifest, paths)
    key = manifest.get("keychain", {})
    credential_present = False
    if key.get("service") and key.get("account"):
        credential_present = (keychain or Keychain()).exists(key["service"], key["account"])
    problems = drift(manifest, paths)
    loaded = (launch_agent or LaunchAgent()).loaded()
    if not loaded:
        problems.append("disabled:launch-agent")
    if not credential_present:
        problems.append("missing:keychain-item")
    return {
        "status": "healthy" if not problems else "needs_repair",
        "job": LABEL,
        "description": DESCRIPTION,
        "version": manifest.get("kit_version"),
        "problems": problems,
    }


def repair(package, release_manifest, paths=None, keychain=None, launch_agent=None):
    """Replace only drifted shipped files; preserve state, configuration, and identities."""
    paths = paths or InstallPaths()
    if not paths.manifest.is_file():
        raise InstallError("there is no v2 installation to repair")
    local = json.loads(paths.manifest.read_text(encoding="utf-8"))
    validate_local_manifest(local, paths)
    if local.get("kit_version") != release_manifest.get("version"):
        raise InstallError("repair requires the installed version; use upgrade for a new version")
    package = Path(package).resolve()
    entries = _package_entries(package, release_manifest)
    key = local.get("keychain", {})
    keychain = keychain or Keychain()
    if not keychain.exists(key.get("service", ""), key.get("account", "")):
        raise InstallError("the recorded Homing Keychain item is absent")
    launch_agent = launch_agent or LaunchAgent()
    replacements = []
    for rel, entry in entries.items():
        if rel in {"SETUP.md", "index.md"}:
            continue
        if rel == "homing-check/SKILL.md":
            target = paths.skill / "SKILL.md"
        else:
            target = paths.runtime / rel
        mode = 0o755 if rel.endswith(".py") else 0o644
        if (
            not target.is_file()
            or target.stat().st_size != entry["bytes"]
            or sha256_file(target) != entry["sha256"]
            or stat.S_IMODE(target.stat().st_mode) != mode
        ):
            replacements.append((package / rel, target, mode))
    expected_plist = launch_agent_bytes(paths, local.get("python", sys.executable))
    plist_drift = not paths.plist.is_file() or paths.plist.read_bytes() != expected_plist
    if not replacements and not plist_drift:
        return {"status": "healthy", "repaired": []}
    stage = Path(tempfile.mkdtemp(prefix=".homing-v2-repair-", dir=str(paths.root.parent)))
    backups = []
    created = []
    was_loaded = launch_agent.loaded()
    repaired = []
    try:
        launch_agent.stop(paths.plist)
        for index, (source, target, mode) in enumerate(replacements):
            staged = stage / ("file-%s" % index)
            shutil.copyfile(str(source), str(staged))
            os.chmod(str(staged), mode)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                backup = stage / ("old-%s" % index)
                target.rename(backup)
                backups.append((backup, target))
            else:
                created.append(target)
            staged.rename(target)
            repaired.append(str(target))
        if plist_drift:
            staged_plist = stage / "job.new"
            staged_plist.write_bytes(expected_plist)
            if paths.plist.exists():
                backup = stage / "job.old"
                paths.plist.rename(backup)
                backups.append((backup, paths.plist))
            else:
                created.append(paths.plist)
            staged_plist.rename(paths.plist)
            repaired.append(str(paths.plist))
        refreshed = _local_manifest(
            paths,
            release_manifest,
            local.get("connection_id"),
            key.get("service"),
            key.get("account"),
            local.get("python", sys.executable),
            local.get("claude", {}),
        )
        manifest_backup = stage / "manifest.old"
        paths.manifest.rename(manifest_backup)
        backups.append((manifest_backup, paths.manifest))
        temp_manifest = paths.root / (LOCAL_MANIFEST + ".new")
        temp_manifest.write_text(
            json.dumps(refreshed, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )
        os.chmod(str(temp_manifest), 0o600)
        os.replace(str(temp_manifest), str(paths.manifest))
        if was_loaded:
            launch_agent.start(paths.plist)
        return {"status": "repaired", "repaired": repaired}
    except Exception:
        for target in reversed(created):
            if target.exists():
                target.unlink()
        for backup, target in reversed(backups):
            if target.exists():
                target.unlink()
            backup.rename(target)
        if was_loaded and paths.plist.exists():
            try:
                launch_agent.start(paths.plist)
            except Exception:
                pass
        raise
    finally:
        shutil.rmtree(str(stage), ignore_errors=True)


def create_v1_rollback(v1_manifest_path, paths=None, v1_connection_id=None):
    """Save exact v1-owned files and nonsecret identity metadata in a private bundle."""
    paths = paths or InstallPaths()
    source_manifest = _read_json(v1_manifest_path)
    if source_manifest.get("schema") != 1:
        raise InstallError("unsupported v1 install manifest")
    manifest_connection_id = source_manifest.get("connection_id")
    if (
        manifest_connection_id
        and v1_connection_id
        and (str(manifest_connection_id).lower() != str(v1_connection_id).lower())
    ):
        raise InstallError("verified v1 connection identity conflicts with its manifest")
    connection_id = manifest_connection_id or v1_connection_id
    try:
        canonical_connection_id = str(uuid.UUID(str(connection_id)))
        if canonical_connection_id != str(connection_id).lower():
            raise ValueError
    except (ValueError, TypeError, AttributeError) as exc:
        raise InstallError("v1 manifest has no valid connection identity") from exc
    scheduler = source_manifest.get("scheduler", {})
    secret_store = source_manifest.get("secret_store", {})
    if not all(
        isinstance(secret_store.get(name), str) and secret_store[name]
        for name in ("service", "account")
    ):
        raise InstallError("v1 manifest has incomplete Keychain identity")
    artifacts = scheduler.get("artifacts") or []
    job_path_raw = scheduler.get("path") or (artifacts[0] if artifacts else None)
    if (
        scheduler.get("kind") != "launchd"
        or not scheduler.get("identifier")
        or not job_path_raw
        or artifacts != [job_path_raw]
    ):
        raise InstallError("v1 rollback requires one identified LaunchAgent")
    try:
        if plistlib.loads(Path(job_path_raw).read_bytes()).get("Label") != scheduler["identifier"]:
            raise InstallError("v1 LaunchAgent identity does not match its manifest")
    except (OSError, plistlib.InvalidFileException) as exc:
        raise InstallError("v1 LaunchAgent is unreadable") from exc
    file_entries = source_manifest.get("files") or []
    candidates = []
    for entry in file_entries:
        if not isinstance(entry, dict) or not entry.get("path"):
            raise InstallError("v1 manifest contains an invalid file entry")
        candidates.append((Path(entry["path"]), entry.get("sha256")))
    candidates.extend((Path(path), None) for path in artifacts)
    candidates.append((Path(v1_manifest_path), None))
    symlinks = []
    for link in source_manifest.get("links") or []:
        if not isinstance(link, dict) or link.get("kind") not in ("symlink", "copy"):
            raise InstallError("v1 manifest contains an invalid linked skill entry")
        link_path = Path(link.get("path", ""))
        if link["kind"] == "symlink":
            if not link_path.is_symlink() or os.readlink(str(link_path)) != link.get("target"):
                raise InstallError("v1 linked skill has drifted: %s" % link_path)
            identity = (os.path.abspath(str(link_path)), link.get("target"))
            if identity not in symlinks:
                symlinks.append(identity)
        else:
            digests = link.get("sha256") or {}
            if not isinstance(digests, dict):
                raise InstallError("v1 copied skill has invalid digests")
            for name, expected in digests.items():
                if _safe_member(name) is None or len(PurePosixPath(name).parts) != 1:
                    raise InstallError("v1 copied skill contains an unsafe path")
                candidates.append((link_path / name, expected))
    unique = []
    seen = set()
    for source, expected in candidates:
        source = source.resolve()
        if str(source) in seen:
            continue
        seen.add(str(source))
        if not source.is_file() or source.is_symlink():
            raise InstallError("v1 rollback source is not a regular file: %s" % source)
        actual = sha256_file(source)
        if expected and actual != expected:
            raise InstallError("v1 rollback source has drifted: %s" % source)
        unique.append((source, actual))
    if (
        len(unique) > MAX_ROLLBACK_FILES
        or sum(path.stat().st_size for path, _ in unique) > MAX_TOTAL_BYTES
    ):
        raise InstallError("v1 rollback bundle exceeds its bounds")
    if paths.rollback.exists():
        raise InstallError("a v1 rollback bundle already exists")
    paths.root.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".rollback-v1-", dir=str(paths.root)))
    try:
        stored = []
        payload_root = stage / "files"
        payload_root.mkdir()
        for index, (source, digest) in enumerate(unique):
            payload = payload_root / str(index)
            shutil.copyfile(str(source), str(payload))
            os.chmod(str(payload), 0o600)
            stored.append(
                {
                    "source": str(source),
                    "payload": "files/%s" % index,
                    "bytes": source.stat().st_size,
                    "sha256": digest,
                    "mode": stat.S_IMODE(source.stat().st_mode),
                }
            )
        record = {
            "schema": 1,
            "files": stored,
            "symlinks": [{"path": path, "target": target} for path, target in symlinks],
            "launch_agent": {"label": scheduler["identifier"], "path": job_path_raw},
            "keychain": {
                "service": secret_store["service"],
                "account": secret_store["account"],
            },
            "connection_id": canonical_connection_id,
            "retirement": {"connection_revoked": False, "keychain_deleted": False},
            "directories": [
                entry.get("path")
                for entry in source_manifest.get("dirs", [])
                if isinstance(entry, dict) and entry.get("path")
            ],
        }
        (stage / "rollback-manifest.json").write_text(
            json.dumps(record, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )
        (stage / OWNER_MARKER).write_text("v1 rollback for " + LABEL + "\n", encoding="utf-8")
        os.chmod(str(stage / "rollback-manifest.json"), 0o600)
        os.chmod(str(stage / OWNER_MARKER), 0o600)
        stage.rename(paths.rollback)
        return record
    finally:
        if stage.exists():
            shutil.rmtree(str(stage), ignore_errors=True)


def deactivate_v1(rollback_record, paths=None, launch_agent=None):
    """Stop v1 and remove only files proven present in its rollback bundle."""
    paths = paths or InstallPaths()
    launch_agent = launch_agent or LaunchAgent()
    job = rollback_record.get("launch_agent", {})
    job_path = Path(job.get("path", ""))
    launch_agent.stop(job_path)
    for entry in rollback_record.get("files", []):
        target = Path(entry["source"])
        if target.exists():
            if (
                not target.is_file()
                or target.is_symlink()
                or sha256_file(target) != entry["sha256"]
            ):
                raise InstallError("refusing to remove changed v1 file: %s" % target)
            target.unlink()
    for entry in rollback_record.get("symlinks", []):
        target = Path(entry["path"])
        if target.is_symlink() and os.readlink(str(target)) == entry["target"]:
            target.unlink()
        elif target.exists() or target.is_symlink():
            raise InstallError("refusing to remove changed v1 link: %s" % target)
    for raw in sorted(rollback_record.get("directories", []), key=len, reverse=True):
        try:
            Path(raw).rmdir()
        except OSError:
            pass


def restore_v1(paths=None, launch_agent=None):
    """Restore the retained v1 files exactly. The caller must stop/remove v2 first."""
    paths = paths or InstallPaths()
    launch_agent = launch_agent or LaunchAgent()
    manifest_path = paths.rollback / "rollback-manifest.json"
    if not manifest_path.is_file():
        raise InstallError("no v1 rollback bundle is available")
    record = _read_json(manifest_path)
    restored = []
    for entry in record.get("files", []):
        payload = paths.rollback / entry["payload"]
        if (
            not payload.is_file()
            or payload.stat().st_size != entry["bytes"]
            or sha256_file(payload) != entry["sha256"]
        ):
            raise InstallError("v1 rollback bundle is damaged")
        target = Path(entry["source"])
        if target.exists() and (not target.is_file() or sha256_file(target) != entry["sha256"]):
            raise InstallError("refusing to overwrite a changed path during rollback: %s" % target)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copyfile(str(payload), str(target))
            os.chmod(str(target), entry["mode"])
            restored.append(str(target))
    for entry in record.get("symlinks", []):
        target = Path(entry["path"])
        if target.exists() or target.is_symlink():
            if not target.is_symlink() or os.readlink(str(target)) != entry["target"]:
                raise InstallError(
                    "refusing to overwrite a changed link during rollback: %s" % target
                )
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(entry["target"])
        restored.append(str(target))
    launch_agent.start(Path(record["launch_agent"]["path"]))
    return {"status": "v1_restored", "restored": restored, "keychain": record.get("keychain")}


def _write_rollback_record(paths, record):
    target = paths.rollback / "rollback-manifest.json"
    staged = paths.rollback / "rollback-manifest.json.new"
    staged.write_text(json.dumps(record, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.chmod(str(staged), 0o600)
    os.replace(str(staged), str(target))


def _validated_retirement_record(paths):
    marker = paths.rollback / OWNER_MARKER
    manifest_path = paths.rollback / "rollback-manifest.json"
    if not paths.rollback.exists():
        return None
    try:
        marker_text = marker.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise InstallError("the v1 rollback bundle is not owned by this installation") from exc
    if not paths.rollback.is_dir() or marker_text != "v1 rollback for " + LABEL + "\n":
        raise InstallError("the v1 rollback bundle is not owned by this installation")
    record = _read_json(manifest_path)
    try:
        connection = str(uuid.UUID(record["connection_id"]))
        key = record["keychain"]
        retirement = record["retirement"]
        launch = record["launch_agent"]
        files = record["files"]
        if (
            connection != record["connection_id"]
            or not all(
                isinstance(key.get(name), str) and key[name] for name in ("service", "account")
            )
            or set(retirement) != {"connection_revoked", "keychain_deleted"}
            or not all(isinstance(value, bool) for value in retirement.values())
            or not isinstance(launch.get("label"), str)
            or not launch["label"]
            or not isinstance(files, list)
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise InstallError("the v1 rollback retirement identity is invalid") from exc
    expected = {OWNER_MARKER, "rollback-manifest.json"}
    for entry in files:
        if not isinstance(entry, dict):
            raise InstallError("the v1 rollback bundle has invalid file metadata")
        payload_name = entry.get("payload", "")
        safe_payload = _safe_member(payload_name)
        if safe_payload is None or safe_payload.parts[0] != "files":
            raise InstallError("the v1 rollback bundle has an unsafe payload path")
        payload = paths.rollback.joinpath(*safe_payload.parts)
        if (
            not payload.is_file()
            or payload.is_symlink()
            or payload.stat().st_size != entry.get("bytes")
            or sha256_file(payload) != entry.get("sha256")
        ):
            raise InstallError("the v1 rollback bundle is damaged")
        expected.add(payload.relative_to(paths.rollback).as_posix())
    actual = {
        path.relative_to(paths.rollback).as_posix()
        for path in paths.rollback.rglob("*")
        if path.is_file()
    }
    for path in paths.rollback.rglob("*"):
        relative = path.relative_to(paths.rollback).as_posix()
        if path.is_symlink() or (path.is_dir() and relative != "files"):
            raise InstallError("the v1 rollback bundle contains unknown resources")
    if actual != expected:
        raise InstallError("the v1 rollback bundle contains unknown files")
    return record


def retire_v1(paths=None, keychain=None, job_inspector=None, revoker=None):
    """Retire only the exact retained v1 connection, Keychain item, and rollback bundle."""
    paths = paths or InstallPaths()
    record = _validated_retirement_record(paths)
    if record is None:
        return {"status": "already_retired"}
    keychain = keychain or Keychain()
    job_inspector = job_inspector or V1JobInspector()
    revoker = revoker or RetirementRevoker()
    label = record["launch_agent"]["label"]
    if job_inspector.loaded(label):
        raise InstallError("v1 is still running; retirement did not begin")
    key = record["keychain"]
    retirement = record["retirement"]
    if not retirement["connection_revoked"]:
        if not keychain.exists(key["service"], key["account"]):
            raise InstallError("the v1 Keychain item is absent before revocation was verified")
        client_path = paths.runtime / "homing.py"
        if not client_path.is_file():
            raise InstallError("the v2 Homing client is unavailable for v1 retirement")
        revoker.revoke(client_path, record["connection_id"], key["service"], key["account"])
        retirement["connection_revoked"] = True
        _write_rollback_record(paths, record)
    if not retirement["keychain_deleted"]:
        if keychain.exists(key["service"], key["account"]):
            keychain.delete(key["service"], key["account"])
        if keychain.exists(key["service"], key["account"]):
            raise InstallError("the exact v1 Keychain item still exists")
        retirement["keychain_deleted"] = True
        _write_rollback_record(paths, record)
    shutil.rmtree(str(paths.rollback))
    if paths.rollback.exists():
        raise InstallError("the v1 rollback bundle could not be removed")
    return {"status": "retired", "connection_id": record["connection_id"]}


def qualify_claude():
    executable = shutil.which("claude")
    if not executable:
        return {
            "supported": False,
            "version": None,
            "executable": None,
            "missing_flags": list(REQUIRED_CLAUDE_FLAGS),
        }
    try:
        version_result = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            env={"PATH": "/usr/bin:/bin"},
        )
        help_result = subprocess.run(
            [executable, "--help"],
            capture_output=True,
            text=True,
            timeout=5,
            env={"PATH": "/usr/bin:/bin"},
        )
        match = re.search(
            r"(?<!\d)(\d+)\.(\d+)\.(\d+)(?!\d)", version_result.stdout + version_result.stderr
        )
        version = tuple(int(part) for part in match.groups()) if match else ()
        help_text = help_result.stdout + help_result.stderr
        missing = [flag for flag in REQUIRED_CLAUDE_FLAGS if flag not in help_text]
        supported = (
            version_result.returncode == 0
            and help_result.returncode == 0
            and version >= MIN_CLAUDE
            and not missing
        )
        return {
            "supported": supported,
            "version": ".".join(str(part) for part in version) if version else None,
            "executable": str(Path(executable).resolve()),
            "missing_flags": missing,
            "argv_template": CLAUDE_ARGV_TEMPLATE,
        }
    except (OSError, subprocess.SubprocessError):
        return {
            "supported": False,
            "version": None,
            "executable": str(executable),
            "missing_flags": list(REQUIRED_CLAUDE_FLAGS),
        }


def probe(paths=None, keychain=None, launch_agent=None):
    paths = paths or InstallPaths()
    writable_parent = paths.root
    while not writable_parent.exists() and writable_parent.parent != writable_parent:
        writable_parent = writable_parent.parent
    result = {
        "supported_os": platform.system() == "Darwin",
        "macos_version": platform.mac_ver()[0] or None,
        "python": platform.python_version(),
        "python_supported": sys.version_info[:2] >= MIN_PYTHON,
        "keychain_available": shutil.which("security") is not None,
        "launchctl_available": shutil.which("launchctl") is not None,
        "installed": paths.manifest.is_file(),
        "install_root_writable": (
            writable_parent.is_dir() and os.access(str(writable_parent), os.W_OK | os.X_OK)
        ),
        "job_loaded": (launch_agent or LaunchAgent()).loaded()
        if shutil.which("launchctl")
        else False,
    }
    qualification = qualify_claude()
    result["claude"] = qualification["version"]
    result["claude_supported"] = qualification["supported"]
    result["claude_missing_flags"] = qualification["missing_flags"]
    result["claude_argv_template"] = CLAUDE_ARGV_TEMPLATE
    return result


def _read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument("--home", help=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("probe")
    action = commands.add_parser("extract")
    action.add_argument("--archive", required=True)
    action.add_argument("--release-manifest", required=True)
    action.add_argument("--destination", required=True)
    action = commands.add_parser("finalize-setup")
    action.add_argument("--workspace", required=True)
    action.add_argument("--release-manifest", required=True)
    commands.add_parser("status")
    for command in ("install", "upgrade"):
        action = commands.add_parser(command)
        action.add_argument("--package", required=True)
        action.add_argument("--release-manifest", required=True)
        action.add_argument("--connection", required=True)
        action.add_argument("--keychain-service", required=True)
        action.add_argument("--keychain-account", required=True)
        if command == "upgrade":
            action.add_argument("--v1-manifest", required=True)
            action.add_argument("--v1-connection-id", required=True)
    action = commands.add_parser("repair")
    action.add_argument("--package", required=True)
    action.add_argument("--release-manifest", required=True)
    commands.add_parser("rollback")
    commands.add_parser("retire-v1")
    args = parser.parse_args(argv)
    paths = InstallPaths(args.home)
    if args.command == "extract":
        extract_verified(args.archive, _read_json(args.release_manifest), args.destination)
        print(
            json.dumps(
                {"status": "extracted", "destination": str(Path(args.destination).resolve())},
                sort_keys=True,
            )
        )
        return 0
    if args.command == "finalize-setup":
        print(
            json.dumps(
                finalize_setup_workspace(args.workspace, args.release_manifest), sort_keys=True
            )
        )
        return 0
    if args.command == "probe":
        print(json.dumps(probe(paths), sort_keys=True))
        return 0
    if args.command == "status":
        print(json.dumps(status(paths), sort_keys=True))
        return 0
    if args.command == "repair":
        print(
            json.dumps(
                repair(args.package, _read_json(args.release_manifest), paths=paths), sort_keys=True
            )
        )
        return 0
    if args.command == "rollback":
        try:
            from uninstall import uninstall
        except ImportError:
            from .uninstall import uninstall
        uninstall(paths)
        print(json.dumps(restore_v1(paths), sort_keys=True))
        return 0
    if args.command == "retire-v1":
        print(json.dumps(retire_v1(paths), sort_keys=True))
        return 0
    if args.command == "upgrade":
        rollback_record = create_v1_rollback(
            args.v1_manifest, paths, v1_connection_id=args.v1_connection_id
        )
        try:
            deactivate_v1(rollback_record, paths)
            manifest = install(
                args.package,
                _read_json(args.release_manifest),
                args.connection,
                args.keychain_service,
                args.keychain_account,
                paths=paths,
            )
        except Exception:
            restore_v1(paths)
            raise
        print(
            json.dumps(
                {
                    "status": "upgraded",
                    "version": manifest["kit_version"],
                    "job": LABEL,
                    "description": DESCRIPTION,
                },
                sort_keys=True,
            )
        )
        return 0
    manifest = install(
        args.package,
        _read_json(args.release_manifest),
        args.connection,
        args.keychain_service,
        args.keychain_account,
        paths=paths,
    )
    print(
        json.dumps(
            {
                "status": "installed",
                "version": manifest["kit_version"],
                "job": LABEL,
                "description": DESCRIPTION,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InstallError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
