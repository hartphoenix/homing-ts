import json
import plistlib
import sqlite3
import sys
import tempfile
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from agentkit.package.homing import HomingClient, HomingError, Response, _pause_is_active
from agentkit.package.install import CLAUDE_ARGV_TEMPLATE, LABEL, InstallPaths, _mark, launch_agent_bytes
from agentkit.package.runner import normalize_snapshot, reconcile_reports, run_once
from agentkit.package.schedule import scheduled_due
from agentkit.package.state import State
from agentkit.package.uninstall import uninstall
from agentkit.package.common import matcher_facts_hash


def project_snapshot():
    query_id = str(uuid.uuid4())
    return query_id, [
        {
            "project_id": str(uuid.uuid4()),
            "current_config_revision": 1,
            "config_sha256": "a" * 64,
            "source_queries": [
                {
                    "id": query_id,
                    "revision": 1,
                    "sha256": "b" * 64,
                    "adapter": "zumper-com",
                    "status": "ready",
                }
            ],
        }
    ]


def observation():
    projection = {
        "source": "zumper-com",
        "listing_id": "listing-1",
        "canonical_url": "https://www.zumper.com/listing-1",
        "title": "Home",
        "description_excerpt": "",
        "evidence": {
            "location": {"state": "present", "value": "Brooklyn"},
            "price": {"state": "present", "value": 250000},
            "availability": {"state": "present", "value": "now"},
            "housing_type": {"state": "present", "value": "apartment"},
        },
    }
    return {
        **projection,
        "facts_hash": matcher_facts_hash(projection),
        "observed_at": "2026-08-29T14:00:00+00:00",
    }


class FakeClient:
    def __init__(self, projects, finish_error=None):
        self._projects = projects
        self.finish_error = finish_error
        self.finished = []

    def projects(self):
        return self._projects

    def config_revision(self, project, revision, digest):
        return {"required_evidence": ["location", "price", "availability", "housing_type"]}

    def source_revision(self, project, revision, digest):
        return {"url": "https://www.zumper.com/homes/brooklyn"}

    def create_run(self, invocation, projects):
        return "server-run-1"

    def finish_run(self, server_id, report):
        if self.finish_error:
            raise self.finish_error
        self.finished.append((server_id, report))

    def deliver(self, project, payload, key):
        return {"observation_id": "lead-1"}


class FailingMatcher:
    def match(self, facts, config):
        raise RuntimeError("model_malformed")


class PackageRuntimeTests(unittest.TestCase):
    def test_configuration_needed_does_not_create_a_local_run(self):
        project = {
            "project_id": str(uuid.uuid4()),
            "config_status": "needed",
            "current_config_revision": None,
            "config_sha256": None,
            "source_queries": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            state = State(Path(directory) / "state.sqlite3")
            result = run_once(
                state,
                FakeClient([project]),
                "manual",
            )
            self.assertEqual(result, {"status": "configuration_needed"})
            self.assertEqual(state.db.execute("SELECT count(*) FROM runs").fetchone()[0], 0)
            state.close()

    def test_local_zero_query_failure_is_not_submitted_or_left_pending(self):
        class Client:
            def __init__(self):
                self.created = False

            def projects(self):
                return []

            def create_run(self, invocation, projects):
                self.created = True
                raise AssertionError("zero-query local report must not be submitted")

        with tempfile.TemporaryDirectory() as directory:
            state = State(Path(directory) / "state.sqlite3")
            state.start_run("local-only", "manual", None, [])
            state.fail_run("local-only", "configuration")
            state.freeze_report("local-only")
            client = Client()
            reconcile_reports(state, client)
            self.assertFalse(client.created)
            self.assertEqual(
                state.db.execute(
                    "SELECT server_report FROM runs WHERE id='local-only'"
                ).fetchone()[0],
                "acknowledged",
            )
            state.close()

    def test_duplicate_snapshot_identities_are_rejected_before_state(self):
        _, projects = project_snapshot()
        projects[0]["source_queries"].append(dict(projects[0]["source_queries"][0]))
        with self.assertRaisesRegex(HomingError, "duplicate query"):
            normalize_snapshot(projects)
        _, duplicate_project = project_snapshot()
        duplicate_projects = [duplicate_project[0], dict(duplicate_project[0])]
        duplicate_projects[1]["source_queries"] = [dict(duplicate_project[0]["source_queries"][0])]
        with self.assertRaisesRegex(HomingError, "duplicate project"):
            normalize_snapshot(duplicate_projects)

    def test_start_run_does_not_translate_arbitrary_integrity_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            state = State(Path(directory) / "state.sqlite3")
            self.assertTrue(state.start_run("scheduled-one", "scheduled", "2026-08-29", []))
            self.assertFalse(state.start_run("scheduled-two", "scheduled", "2026-08-29", []))
            with self.assertRaises(sqlite3.IntegrityError):
                state.start_run(
                    "bad-ref",
                    "manual",
                    None,
                    [
                        {
                            "project_id": "project",
                            "prompt_revision": "1",
                            "prompt_hash": "a" * 64,
                            "query_id": "query",
                            "query_revision": "1",
                            "query_hash": None,
                            "adapter": "zumper-com",
                            "validator_version": "v2-wire-1",
                        }
                    ],
                )
            self.assertEqual(state.db.execute("SELECT count(*) FROM runs").fetchone()[0], 1)
            state.close()

    def test_matcher_failure_is_reported_on_the_source_query(self):
        query_id, projects = project_snapshot()
        with tempfile.TemporaryDirectory() as directory:
            state = State(Path(directory) / "state.sqlite3")
            client = FakeClient(projects)
            result = run_once(
                state,
                client,
                "manual",
                acquire_port=lambda query: SimpleNamespace(
                    observations=[observation()], body=b"facts", body_hash="facts-hash"
                ),
                matcher=FailingMatcher(),
            )
            self.assertEqual(result["status"], "incomplete")
            self.assertEqual(result["queries"], [{
                "source_query_revision_id": query_id,
                "status": "malformed",
                "error_class": "model_malformed",
            }])
            self.assertIsNone(result["failure"])
            self.assertEqual(result["counts"]["source_queries_total"], 1)
            self.assertEqual(client.finished[0][1], result)
            state.close()

    def test_finalization_failure_is_visible_and_report_remains_pending(self):
        _, projects = project_snapshot()
        with tempfile.TemporaryDirectory() as directory:
            state = State(Path(directory) / "state.sqlite3")
            client = FakeClient(projects, HomingError("unavailable", "offline", retryable=True))
            with self.assertRaises(HomingError):
                run_once(
                    state,
                    client,
                    "manual",
                    acquire_port=lambda query: SimpleNamespace(
                        observations=[observation()], body=b"facts", body_hash="facts-hash"
                    ),
                    matcher=FailingMatcher(),
                )
            row = state.db.execute("SELECT server_report FROM runs").fetchone()
            self.assertEqual(row[0], "pending")
            self.assertEqual(len(state.unfinished_reports()), 1)
            state.close()

    def test_pause_and_disconnect_create_no_local_run(self):
        class Client:
            def __init__(self, kind):
                self.kind = kind

            def projects(self):
                raise HomingError(self.kind, self.kind)

        for kind, expected in (("paused", "paused"), ("authentication", "disconnected")):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                state = State(Path(directory) / "state.sqlite3")
                self.assertEqual(run_once(state, Client(kind), "manual"), {"status": expected})
                self.assertEqual(state.db.execute("SELECT count(*) FROM runs").fetchone()[0], 0)
                state.close()

    def test_reconciliation_preflights_before_interrupting_local_work(self):
        class Disconnected:
            def projects(self):
                raise HomingError("authentication", "disconnected")

        with tempfile.TemporaryDirectory() as directory:
            state = State(Path(directory) / "state.sqlite3")
            state.start_run("open", "manual", None, [])
            with self.assertRaises(HomingError):
                reconcile_reports(state, Disconnected())
            row = state.db.execute("SELECT outcome,error_class FROM runs").fetchone()
            self.assertEqual(tuple(row), (None, None))
            state.close()

    def test_expired_pause_is_not_treated_as_active(self):
        now = datetime.now(timezone.utc)
        self.assertTrue(_pause_is_active((now + timedelta(minutes=1)).isoformat()))
        self.assertFalse(_pause_is_active((now - timedelta(minutes=1)).isoformat()))

    def test_scheduler_and_job_identity_are_legible(self):
        now = datetime(2026, 8, 29, 10, tzinfo=timezone.utc)
        self.assertTrue(scheduled_due(now, None))
        self.assertFalse(scheduled_due(now.replace(hour=8), None))
        self.assertTrue(scheduled_due(now.replace(hour=8), date(2026, 8, 27)))
        with tempfile.TemporaryDirectory() as directory:
            paths = InstallPaths(directory)
            plist = plistlib.loads(launch_agent_bytes(paths))
            self.assertEqual(plist["Label"], LABEL)
            self.assertEqual(plist["StartCalendarInterval"], {"Hour": 9, "Minute": 0})
            self.assertEqual(plist["StandardOutPath"], str(paths.logs / "search.log"))

    def test_removal_preserves_unrelated_root_residue_and_reports_it(self):
        class Keychain:
            def __init__(self):
                self.deleted = []

            def delete(self, service, account):
                self.deleted.append((service, account))

        class Launch:
            def stop(self, plist):
                self.plist = plist

        class Disconnect:
            def disconnect(self, runtime, connection):
                return "disconnected"

        with tempfile.TemporaryDirectory() as directory:
            paths = InstallPaths(directory)
            for root in (paths.runtime, paths.state, paths.logs, paths.skill):
                _mark(root)
            (paths.root / "keep.txt").write_text("unrelated", encoding="utf-8")
            manifest = {
                "schema": 1,
                "kit_version": 2,
                "package_sha256": "a" * 64,
                "origin": "https://homing.test",
                "description": "Homing housing search",
                "connection_id": str(uuid.uuid4()),
                "keychain": {"service": "service", "account": "account"},
                "launch_agent": {"label": LABEL, "path": str(paths.plist)},
                "python": sys.executable,
                "claude": {
                    "version": "2.1.247",
                    "executable": sys.executable,
                    "argv_template": CLAUDE_ARGV_TEMPLATE,
                },
                "files": [],
                "owned_roots": [str(paths.runtime), str(paths.state), str(paths.logs), str(paths.skill)],
            }
            paths.manifest.write_text(json.dumps(manifest), encoding="utf-8")
            keychain = Keychain()
            result = uninstall(paths, keychain, Launch(), Disconnect())
            self.assertEqual(result["status"], "residue")
            self.assertEqual(result["residue"], ["keep.txt"])
            self.assertTrue((paths.root / "keep.txt").is_file())
            self.assertEqual(keychain.deleted, [("service", "account")])


if __name__ == "__main__":
    unittest.main()
