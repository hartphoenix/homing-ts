#!/usr/bin/env python3
"""Evidence-based installed lifecycle check. It never reads credential values or config bodies."""

import json
import plistlib
import sqlite3
import subprocess

try:
    from install import (
        InstallError,
        InstallPaths,
        Keychain,
        LaunchAgent,
        drift,
        validate_local_manifest,
    )
except ImportError:
    from .install import (
        InstallError,
        InstallPaths,
        Keychain,
        LaunchAgent,
        drift,
        validate_local_manifest,
    )


def check(paths=None, keychain=None, launch_agent=None, executor=None, execute=True):
    paths = paths or InstallPaths()
    keychain = keychain or Keychain()
    launch_agent = launch_agent or LaunchAgent()
    evidence = []
    try:
        manifest = json.loads(paths.manifest.read_text(encoding="utf-8"))
        validate_local_manifest(manifest, paths)
        evidence.append({"check": "manifest", "status": "passed"})
        problems = drift(manifest, paths)
        evidence.append(
            {
                "check": "shipped_files",
                "status": "passed" if not problems else "failed",
                "problems": problems,
            }
        )
        key = manifest["keychain"]
        credential = keychain.exists(key["service"], key["account"])
        evidence.append(
            {"check": "credential_metadata", "status": "passed" if credential else "failed"}
        )
        plist = plistlib.loads(paths.plist.read_bytes())
        expected = [manifest["python"], str(paths.runtime / "runner.py"), "scheduled"]
        job_exact = (
            plist.get("Label") == manifest["launch_agent"]["label"]
            and plist.get("ProgramArguments") == expected
            and plist.get("StartCalendarInterval") == {"Hour": 9, "Minute": 0}
            and plist.get("RunAtLoad") is True
        )
        loaded = launch_agent.loaded()
        evidence.append(
            {
                "check": "launch_agent",
                "status": "passed" if job_exact and loaded else "failed",
                "loaded": loaded,
                "record_exact": job_exact,
            }
        )
        if execute:
            run = executor or _execute
            ledger_before = _paused_ledger_snapshot(paths)
            invocation = run(expected)
            outcome = invocation.get("outcome")
            ledger_after = _paused_ledger_snapshot(paths)
            paused_without_work = outcome == "paused" and ledger_before == ledger_after
            run_ok = invocation.get("returncode") == 0 and (
                outcome in {"completed", "not_due"} or paused_without_work
            )
            evidence.append(
                {
                    "check": "scheduled_command",
                    "status": "passed" if run_ok else "failed",
                    "returncode": invocation.get("returncode"),
                    "outcome": outcome,
                    "paused_ledger_before": ledger_before if outcome == "paused" else None,
                    "paused_ledger_after": ledger_after if outcome == "paused" else None,
                }
            )
    except (
        InstallError,
        OSError,
        ValueError,
        json.JSONDecodeError,
        plistlib.InvalidFileException,
    ) as exc:
        evidence.append({"check": "lifecycle", "status": "failed", "error": type(exc).__name__})
    passed = all(item["status"] == "passed" for item in evidence)
    return {"status": "passed" if passed else "failed", "evidence": evidence}


def _paused_ledger_snapshot(paths):
    """Return the local work markers that a paused run must not create or change."""
    database = paths.state / "state.sqlite3"
    if not database.exists():
        return {"due_markers": 0, "acquisitions": 0, "dispositions": 0, "deliveries": 0}
    try:
        connection = sqlite3.connect("file:%s?mode=ro" % database, uri=True)
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        required = {"runs", "run_queries", "run_candidates", "deliveries"}
        if not required <= tables:
            raise InstallError("the local state ledger is incomplete")
        snapshot = {
            "due_markers": connection.execute(
                "SELECT count(*) FROM runs WHERE mode='scheduled' AND due_date IS NOT NULL"
            ).fetchone()[0],
            "acquisitions": connection.execute(
                "SELECT count(*) FROM run_queries WHERE attempted=1 OR status <> 'pending' OR batch_id IS NOT NULL"
            ).fetchone()[0],
            "dispositions": connection.execute(
                "SELECT count(*) FROM run_candidates"
            ).fetchone()[0],
            "deliveries": connection.execute("SELECT count(*) FROM deliveries").fetchone()[0],
        }
        connection.close()
        return snapshot
    except sqlite3.Error as exc:
        raise InstallError("the local state ledger cannot be inspected") from exc


def _execute(argv):
    try:
        process = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=600,
            env={"PATH": "/usr/bin:/bin:/usr/local/bin"},
        )
    except (OSError, subprocess.SubprocessError):
        return {"returncode": None, "outcome": "invocation_error"}
    if len(process.stdout.encode("utf-8", "replace")) > 65536:
        return {"returncode": process.returncode, "outcome": "malformed"}
    try:
        result = json.loads(process.stdout)
        outcome = (
            result.get("outcome", result.get("status")) if isinstance(result, dict) else "malformed"
        )
    except json.JSONDecodeError:
        outcome = "malformed"
    return {"returncode": process.returncode, "outcome": outcome}


def main():
    result = check()
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
