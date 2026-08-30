#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    try:
        from runtime.acquire import AcquisitionError, VALIDATOR_VERSION
        from runtime.common import (
            canonical_json,
            matcher_facts_hash,
            matcher_projection,
            sha256,
            validate_required,
        )
        from runtime.homing import HomingError
        from runtime.schedule import scheduled_due
        from runtime.state import State
    except ModuleNotFoundError:
        from package.acquire import AcquisitionError, VALIDATOR_VERSION
        from package.common import (
            canonical_json,
            matcher_facts_hash,
            matcher_projection,
            sha256,
            validate_required,
        )
        from package.homing import HomingError
        from package.schedule import scheduled_due
        from package.state import State
else:
    from .acquire import AcquisitionError, VALIDATOR_VERSION
    from .common import (
        canonical_json,
        matcher_facts_hash,
        matcher_projection,
        sha256,
        validate_required,
    )
    from .homing import HomingError
    from .schedule import scheduled_due
    from .state import State


class HomingSubprocessClient:
    """Closed runner port; the child alone can resolve and read the Keychain item."""

    def __init__(self, runtime: Path, timeout: int = 45):
        self.command = [sys.executable, str(runtime / "homing.py")]
        self.timeout = timeout

    def _call(self, args: list[str], payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        env = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE"}
        }
        try:
            process = subprocess.run(
                self.command + args,
                input=None if payload is None else json.dumps(payload, separators=(",", ":")),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise HomingError("timeout", "Homing client process timed out", retryable=True) from exc
        except OSError as exc:
            raise HomingError(
                "unavailable", "Homing client process is unavailable", retryable=True
            ) from exc
        if process.returncode:
            try:
                kind = json.loads(process.stderr).get("error", "client")
            except (json.JSONDecodeError, AttributeError):
                kind = "client"
            raise HomingError(
                kind,
                "Homing client request failed",
                retryable=kind in {"timeout", "unavailable", "throttled"},
            )
        try:
            value = json.loads(process.stdout)
        except json.JSONDecodeError as exc:
            raise HomingError("malformed", "Homing client returned malformed output") from exc
        if not isinstance(value, dict):
            raise HomingError("malformed", "Homing client returned a non-object")
        return value

    def projects(self) -> list[Dict[str, Any]]:
        value = self._call(["projects"]).get("projects")
        if not isinstance(value, list):
            raise HomingError("malformed", "project snapshot is missing")
        return value

    def config_revision(self, project: str, revision: str, digest: str) -> Dict[str, Any]:
        return self._call(["config", project, revision, digest])

    def source_revision(self, project: str, revision: str, digest: str) -> Dict[str, Any]:
        return self._call(["source", project, revision, digest])

    def create_run(self, invocation: str, projects: list[Dict[str, Any]]) -> str:
        return str(
            self._call(["create-run"], {"invocation_id": invocation, "projects": projects})["id"]
        )

    def finish_run(self, server_id: str, report: Dict[str, Any]) -> None:
        self._call(["finish-run", server_id], report)

    def deliver(self, project: str, payload: Dict[str, Any], key: str) -> Dict[str, Any]:
        return self._call(["deliver", project, key], payload)


class AcquisitionSubprocessPort:
    def __init__(self, runtime: Path, timeout: int = 45):
        self.runtime, self.timeout = runtime, timeout

    def __call__(self, query: Dict[str, Any]) -> Any:
        adapter = query.get("adapter", "")
        env = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE"}
        }
        try:
            process = subprocess.run(
                [sys.executable, str(self.runtime / "acquire.py"), adapter],
                input=json.dumps(query, separators=(",", ":")),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                timeout=self.timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise AcquisitionError("timeout", "source acquisition timed out") from exc
        except OSError as exc:
            raise AcquisitionError(
                "unavailable", "source acquisition process is unavailable"
            ) from exc
        try:
            value = json.loads(process.stdout)
        except json.JSONDecodeError as exc:
            raise AcquisitionError(
                "malformed", "source acquisition returned malformed output"
            ) from exc
        if process.returncode or value.get("status") != "completed":
            raise AcquisitionError(
                value.get("status", "malformed"), value.get("error", "source acquisition failed")
            )
        observations = value.get("observations")
        if not isinstance(observations, list):
            raise AcquisitionError("malformed", "source acquisition omitted observations")
        body = b"\n".join(canonical_json(item) for item in observations)
        expected = value.get("body_hash")
        if sha256(body) != expected:
            raise AcquisitionError("malformed", "source acquisition body hash mismatch")
        from types import SimpleNamespace

        return SimpleNamespace(observations=observations, body=body, body_hash=expected)


class MatchSubprocessPort:
    def __init__(self, runtime: Path, claude_executable: str = "claude", timeout: int = 150):
        self.command = [
            sys.executable,
            str(runtime / "match.py"),
            "--claude-executable",
            claude_executable,
        ]
        self.timeout = timeout

    def match(self, observation: Dict[str, Any], config: Dict[str, Any]) -> Any:
        env = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE"}
        }
        try:
            process = subprocess.run(
                self.command,
                input=json.dumps(
                    {"observation": observation, "config": config}, separators=(",", ":")
                ),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                timeout=self.timeout,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError("model_unavailable") from exc
        if process.returncode:
            raise RuntimeError("model_failed")
        try:
            value = json.loads(process.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError("model_malformed") from exc
        if not isinstance(value, dict) or set(value) != {"disposition", "reason", "unknowns"}:
            raise RuntimeError("model_malformed")
        if value["disposition"] not in {"kept", "rejected", "insufficient"} or not isinstance(
            value["reason"], str
        ):
            raise RuntimeError("model_malformed")
        if not isinstance(value["unknowns"], list) or any(
            key not in {"location", "price", "availability", "housing_type"}
            for key in value["unknowns"]
        ):
            raise RuntimeError("model_malformed")
        from types import SimpleNamespace

        return SimpleNamespace(
            disposition=value["disposition"],
            reason=value["reason"],
            unknowns=tuple(value["unknowns"]),
        )


def normalize_snapshot(
    projects: list[Dict[str, Any]],
) -> tuple[list[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    refs, projects_by_id = [], {}
    for project in projects:
        project_id = str(project.get("project_id", ""))
        revision = str(project.get("current_config_revision", ""))
        digest = project.get("config_sha256")
        queries = project.get("source_queries")
        if (
            not project_id
            or not revision
            or not isinstance(digest, str)
            or not isinstance(queries, list)
        ):
            raise HomingError("malformed", "Project snapshot has incomplete revision references")
        if not queries or len(queries) > 8:
            raise HomingError(
                "configuration", "Project must have between one and eight configured source queries"
            )
        projects_by_id[project_id] = project
        adapter_counts: Dict[str, int] = {}
        for query in queries:
            if query.get("status") == "needs_review":
                raise HomingError("configuration", "A configured source needs review")
            adapter = query.get("adapter")
            if adapter not in {"zumper-com", "streeteasy-com"}:
                raise HomingError("configuration", "Project uses an unsupported source")
            adapter_counts[adapter] = adapter_counts.get(adapter, 0) + 1
            if adapter_counts[adapter] > 4:
                raise HomingError(
                    "configuration", "Project has more than four queries for one adapter"
                )
            refs.append(
                {
                    "project_id": project_id,
                    "prompt_revision": revision,
                    "prompt_hash": digest,
                    "query_id": str(query.get("id", "")),
                    "query_revision": str(query.get("revision", query.get("id", ""))),
                    "query_hash": query.get("sha256", ""),
                    "adapter": adapter,
                    "validator_version": VALIDATOR_VERSION,
                }
            )
    if any(not ref["query_id"] or not ref["query_hash"] for ref in refs):
        raise HomingError("malformed", "Source snapshot has incomplete revision references")
    return refs, projects_by_id


def snapshot_wire(projects: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    return [
        {
            "project_id": item["project_id"],
            "config_revision": item["current_config_revision"],
            "config_sha256": item["config_sha256"],
            "source_queries": [
                {
                    "id": str(query["id"]),
                    "revision": query.get("revision", query["id"]),
                    "sha256": query["sha256"],
                }
                for query in item["source_queries"]
            ],
        }
        for item in projects
    ]


def reconcile_reports(
    state: State,
    client: Any,
    projects_snapshot: Optional[list[Dict[str, Any]]] = None,
) -> None:
    if projects_snapshot is None:
        client.projects()
    state.interrupt_open_runs()
    for row in state.unfinished_reports():
        if not row["report_body"]:
            continue
        server_id = row["server_run_id"]
        if not server_id:
            grouped: Dict[str, Dict[str, Any]] = {}
            for query in state.db.execute(
                "SELECT * FROM run_queries WHERE run_id=? ORDER BY id", (row["id"],)
            ):
                project = grouped.setdefault(
                    query["project_id"],
                    {
                        "project_id": query["project_id"],
                        "config_revision": query["prompt_revision"],
                        "config_sha256": query["prompt_hash"],
                        "source_queries": [],
                    },
                )
                project["source_queries"].append(
                    {
                        "id": query["query_id"],
                        "revision": query["query_revision"],
                        "sha256": query["query_hash"],
                    }
                )
            server_id = client.create_run(row["id"], list(grouped.values()))
            state.set_server_id(row["id"], server_id)
        client.finish_run(server_id, json.loads(row["report_body"]))
        state.acknowledge_report(row["id"])


def run_once(
    state: State,
    client: Any,
    mode: str,
    now: Optional[datetime] = None,
    acquire_port: Optional[Callable[[Dict[str, Any]], Any]] = None,
    matcher: Optional[Any] = None,
    crash_hook: Optional[Callable[[str], None]] = None,
    projects_snapshot: Optional[list[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    now = now or datetime.now().astimezone()
    acquire_port = acquire_port or AcquisitionSubprocessPort(Path(__file__).resolve().parent)
    due_date = now.date().isoformat() if mode == "scheduled" else None
    recovery = state.recovery_candidate(due_date) if due_date else None
    if mode == "scheduled":
        latest = state.db.execute(
            "SELECT max(due_date) FROM runs WHERE mode='scheduled'"
        ).fetchone()[0]
        last_date = datetime.strptime(latest, "%Y-%m-%d").date() if latest else None
        if recovery is None and not scheduled_due(now, last_date):
            return {"status": "not_due"}
    invocation = str(uuid.uuid4())
    try:
        projects = projects_snapshot if projects_snapshot is not None else client.projects()
        refs, by_project = normalize_snapshot(projects)
    except HomingError as exc:
        if exc.kind == "paused":
            return {"status": "paused"}
        if exc.kind in {"authentication", "permission"}:
            return {"status": "disconnected"}
        if exc.retryable:
            return {"status": "unavailable"}
        started = (
            state.start_recovery(invocation, recovery["id"], due_date, [])
            if recovery is not None
            else state.start_run(invocation, mode, due_date, [])
        )
        if not started:
            return {"status": "already_run"}
        state.fail_run(
            invocation,
            "authentication"
            if exc.kind in {"authentication", "permission"}
            else "configuration"
            if exc.kind in {"configuration", "malformed"}
            else "timeout"
            if exc.kind == "timeout"
            else "startup",
        )
        return state.freeze_report(invocation)
    started = (
        state.start_recovery(invocation, recovery["id"], due_date, refs)
        if recovery is not None
        else state.start_run(invocation, mode, due_date, refs)
    )
    if not started:
        return {"status": "already_run"}
    try:
        server_id = client.create_run(invocation, snapshot_wire(projects))
    except HomingError as exc:
        state.fail_run(
            invocation,
            "authentication"
            if exc.kind in {"authentication", "permission"}
            else "timeout"
            if exc.kind == "timeout"
            else "startup",
        )
        query_error = (
            "authentication"
            if exc.kind in {"authentication", "permission"}
            else "timeout"
            if exc.kind == "timeout"
            else "startup"
        )
        for query in state.pending_queries(invocation):
            state.fail_query(query["id"], query_error)
        return state.freeze_report(invocation)
    state.set_server_id(invocation, server_id)
    if recovery is not None:
        state.reuse_completed_queries(invocation, recovery["id"])
    active = {ref["project_id"]: ref["prompt_revision"] for ref in refs}
    state.carry_work(invocation, active)

    configs: Dict[tuple[str, str], Dict[str, Any]] = {}
    source_payloads: Dict[tuple[str, str], Dict[str, Any]] = {}
    try:
        for project_id, project in by_project.items():
            revision = str(project["current_config_revision"])
            configs[(project_id, revision)] = client.config_revision(
                project_id, revision, project["config_sha256"]
            )
            validate_required(configs[(project_id, revision)].get("required_evidence", []))
        for ref in refs:
            source_payloads[(ref["project_id"], ref["query_id"])] = client.source_revision(
                ref["project_id"], ref["query_id"], ref["query_hash"]
            )
    except (HomingError, ValueError) as exc:
        kind = getattr(exc, "kind", "configuration")
        state.fail_run(
            invocation,
            "configuration"
            if kind in {"configuration", "hash_mismatch"}
            else "timeout"
            if kind == "timeout"
            else "startup",
        )
        for query in state.pending_queries(invocation):
            state.fail_query(
                query["id"],
                "configuration"
                if kind in {"configuration", "hash_mismatch"}
                else "timeout"
                if kind == "timeout"
                else "unavailable",
            )
        report = state.freeze_report(invocation)
        client.finish_run(server_id, report)
        state.acknowledge_report(invocation)
        return report

    state.phase(invocation, "acquire")
    for query in state.pending_queries(invocation):
        state.attempt_query(query["id"])
        source_payload = source_payloads[(query["project_id"], query["query_id"])]
        request = dict(source_payload)
        request["adapter"] = query["adapter"]
        try:
            result = acquire_port(request)
            observations = []
            for item in result.observations:
                projection = matcher_projection(item)
                if item.get("facts_hash") != matcher_facts_hash(projection):
                    raise AcquisitionError("malformed", "source observation facts hash mismatch")
                observations.append(
                    {
                        "source": projection["source"],
                        "listing_id": projection["listing_id"],
                        "canonical_url": projection["canonical_url"],
                        "facts_hash": item["facts_hash"],
                        "observed_at": item["observed_at"],
                        "body": canonical_json(projection),
                    }
                )
            batch_id = sha256(
                (invocation + ":" + str(query["id"]) + ":" + result.body_hash).encode()
            )
            state.complete_query(query, batch_id, result.body, result.body_hash, observations)
        except AcquisitionError as exc:
            state.fail_query(
                query["id"],
                exc.kind
                if exc.kind
                in {
                    "blocked",
                    "unavailable",
                    "malformed",
                    "partial",
                    "timeout",
                    "redirect",
                    "configuration",
                }
                else "malformed",
            )

    state.phase(invocation, "match")
    matcher = matcher or MatchSubprocessPort(Path(__file__).resolve().parent)
    for candidate in state.pending_candidates(invocation):
        prior = state.prior_disposition(
            candidate["project_id"],
            candidate["prompt_revision"],
            candidate["observation_id"],
            invocation,
        )
        if prior:
            state.decide_candidate(
                candidate["id"],
                prior["status"],
                prior["reason"],
                json.loads(prior["unknowns"] or "[]"),
            )
            if crash_hook:
                crash_hook("after_candidate_decision")
            continue
        config = configs[(candidate["project_id"], candidate["prompt_revision"])]
        try:
            result = matcher.match(json.loads(candidate["body"]), config)
            state.decide_candidate(
                candidate["id"], result.disposition, result.reason, result.unknowns
            )
            if crash_hook:
                crash_hook("after_candidate_decision")
        except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
            error_class = str(exc) if isinstance(exc, RuntimeError) else "model_malformed"
            if error_class not in {"model_failed", "model_malformed", "model_unavailable"}:
                error_class = "model_malformed"
            if not state.fail_match(invocation, candidate["observation_id"], error_class):
                state.fail_run(invocation, error_class)

    state.phase(invocation, "deliver")
    kept = list(
        state.db.execute(
            """SELECT rc.*,o.facts_hash,o.body,c.source,c.listing_id,c.canonical_url
      FROM run_candidates rc JOIN observations o ON o.id=rc.observation_id JOIN candidates c ON c.id=o.candidate_id
      WHERE rc.run_id=? AND rc.status='kept'""",
            (invocation,),
        )
    )
    for candidate in kept:
        observation = json.loads(candidate["body"])
        evidence = observation["evidence"]
        price_minor = (
            evidence["price"].get("value") if evidence["price"]["state"] == "present" else None
        )
        raw_type = str(evidence["housing_type"].get("value", "")).casefold()
        housing_type = (
            "shared"
            if any(word in raw_type for word in ("room", "shared"))
            else (
                "entire"
                if any(
                    word in raw_type for word in ("apartment", "house", "home", "condo", "studio")
                )
                else "unknown"
            )
        )
        revision_value: Any = (
            int(candidate["prompt_revision"])
            if candidate["prompt_revision"].isdigit()
            else candidate["prompt_revision"]
        )
        payload = {
            "prompt_revision": revision_value,
            "facts_hash": candidate["facts_hash"],
            "lead": {
                "source": observation["source"],
                "source_listing_id": observation["listing_id"],
                "url": observation["canonical_url"],
                "title": observation["title"],
                "summary": observation.get("description_excerpt", ""),
                "location": evidence["location"].get("value", "")
                if evidence["location"]["state"] == "present"
                else "",
                "price_amount": ("%d.%02d" % divmod(price_minor, 100))
                if price_minor is not None
                else None,
                "price_display": ("$%s" % ("%d.%02d" % divmod(price_minor, 100)))
                if price_minor is not None
                else "",
                "availability": evidence["availability"].get("value", "")
                if evidence["availability"]["state"] == "present"
                else "",
                "housing_type": housing_type,
            },
        }
        key = sha256(
            canonical_json(
                {
                    "project": candidate["project_id"],
                    "prompt": candidate["prompt_revision"],
                    "source": candidate["source"],
                    "listing": candidate["listing_id"],
                    "facts": candidate["facts_hash"],
                }
            )
        )
        state.ensure_delivery(invocation, candidate, canonical_json(payload), key)
        if crash_hook:
            crash_hook("after_delivery_enqueued")
    for delivery in state.pending_deliveries(invocation):
        try:
            response = client.deliver(
                delivery["project_id"], json.loads(delivery["payload"]), delivery["idempotency_key"]
            )
            if crash_hook:
                crash_hook("after_remote_delivery")
            state.update_delivery(
                delivery["id"], "acknowledged", str(response.get("observation_id", ""))
            )
        except HomingError as exc:
            status = {
                "authentication": "blocked_auth",
                "permission": "blocked_permission",
                "invalid": "terminal_error",
                "conflict": "terminal_error",
            }.get(exc.kind, "pending")
            state.update_delivery(delivery["id"], status, reason=exc.kind)
    report = state.freeze_report(invocation)
    client.finish_run(server_id, report)
    state.acknowledge_report(invocation)
    return report


def status(state: State) -> Dict[str, Any]:
    row = state.db.execute("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").fetchone()
    if not row:
        return {"status": "never_run"}
    value = dict(row)
    value["counts"] = state.derive(row["id"])["counts"]
    return value


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("manual", "scheduled", "status"))
    args = parser.parse_args(argv)
    runtime = Path(__file__).resolve().parent
    state = State(runtime.parent / "state" / "state.sqlite3")
    if args.mode == "status":
        print(json.dumps(status(state), sort_keys=True))
        return 0
    lock_path = runtime.parent / "state" / "runner.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w", encoding="ascii") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"status": "already_running"}))
            return 0
        client = HomingSubprocessClient(runtime)
        state.prune(datetime.now(timezone.utc).isoformat())
        manifest = json.loads(
            (runtime.parent / "install-manifest.json").read_text(encoding="utf-8")
        )
        claude_executable = manifest["claude"]["executable"]
        try:
            try:
                projects = client.projects()
            except HomingError as exc:
                if exc.kind == "paused":
                    result = {"status": "paused"}
                elif exc.kind in {"authentication", "permission"}:
                    result = {"status": "disconnected"}
                elif exc.retryable:
                    result = {"status": "unavailable"}
                else:
                    result = run_once(
                        state,
                        client,
                        args.mode,
                        matcher=MatchSubprocessPort(runtime, claude_executable),
                    )
            else:
                reconcile_reports(state, client, projects_snapshot=projects)
                result = run_once(
                    state,
                    client,
                    args.mode,
                    matcher=MatchSubprocessPort(runtime, claude_executable),
                    projects_snapshot=projects,
                )
        except HomingError as exc:
            print(json.dumps({"status": "error", "phase": "finish", "error": exc.kind}))
            return 2
        print(json.dumps(result, sort_keys=True))
        return (
            0
            if result.get("status")
            in {
                "completed",
                "not_due",
                "already_run",
                "paused",
            }
            else 2
        )


if __name__ == "__main__":
    raise SystemExit(main())
