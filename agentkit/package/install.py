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
    action = commands.add_parser("repair")
    action.add_argument("--package", required=True)
    action.add_argument("--release-manifest", required=True)
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
    if args.command == "upgrade":
        manifest = install(
            args.package,
            _read_json(args.release_manifest),
            args.connection,
            args.keychain_service,
            args.keychain_account,
            paths=paths,
            new_connection=False,
        )
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
