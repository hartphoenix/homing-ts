from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, Optional


SCHEMA_VERSION = 1
SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('manual','scheduled')),
  due_date TEXT, phase TEXT NOT NULL CHECK(phase IN ('snapshot','acquire','match','deliver','finish')),
  started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT CHECK(outcome IN ('completed','incomplete','failed')),
  server_run_id TEXT, server_report TEXT NOT NULL DEFAULT 'pending' CHECK(server_report IN ('pending','acknowledged')),
  error_class TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_scheduled_date ON runs(due_date) WHERE mode='scheduled';
CREATE TABLE IF NOT EXISTS run_queries(
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), project_id TEXT NOT NULL,
  prompt_revision TEXT NOT NULL, prompt_hash TEXT NOT NULL, query_id TEXT NOT NULL,
  query_revision TEXT NOT NULL, query_hash TEXT NOT NULL, adapter TEXT NOT NULL,
  validator_version TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0,1)),
  status TEXT NOT NULL DEFAULT 'pending', error_class TEXT, batch_id TEXT,
  UNIQUE(run_id, project_id, prompt_revision, query_id, query_revision)
);
CREATE TABLE IF NOT EXISTS source_batches(
  id TEXT PRIMARY KEY, query_id TEXT NOT NULL, query_revision TEXT NOT NULL,
  prompt_revision TEXT NOT NULL, validator_version TEXT NOT NULL, body BLOB,
  body_hash TEXT NOT NULL, item_count INTEGER NOT NULL, completed_at TEXT NOT NULL, prune_after TEXT
);
CREATE TABLE IF NOT EXISTS source_freshness(
  query_id TEXT NOT NULL, query_revision TEXT NOT NULL, prompt_revision TEXT NOT NULL,
  validator_version TEXT NOT NULL, batch_id TEXT NOT NULL, completed_at TEXT NOT NULL,
  PRIMARY KEY(query_id, query_revision, prompt_revision, validator_version)
);
CREATE TABLE IF NOT EXISTS candidates(
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, listing_id TEXT NOT NULL, canonical_url TEXT NOT NULL,
  UNIQUE(source, listing_id)
);
CREATE TABLE IF NOT EXISTS observations(
  id INTEGER PRIMARY KEY, candidate_id INTEGER NOT NULL REFERENCES candidates(id), facts_hash TEXT NOT NULL,
  body BLOB, observed_at TEXT NOT NULL, prune_after TEXT, UNIQUE(candidate_id, facts_hash)
);
CREATE TABLE IF NOT EXISTS query_observations(
  run_query_id INTEGER NOT NULL REFERENCES run_queries(id), observation_id INTEGER NOT NULL REFERENCES observations(id),
  PRIMARY KEY(run_query_id, observation_id)
);
CREATE TABLE IF NOT EXISTS run_candidates(
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), project_id TEXT NOT NULL,
  prompt_revision TEXT NOT NULL, observation_id INTEGER NOT NULL REFERENCES observations(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','kept','rejected','insufficient','cancelled')),
  reason TEXT, unknowns TEXT, decided_at TEXT, carried_from TEXT,
  UNIQUE(run_id, project_id, prompt_revision, observation_id)
);
CREATE TABLE IF NOT EXISTS deliveries(
  id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, prompt_revision TEXT NOT NULL, source TEXT NOT NULL,
  listing_id TEXT NOT NULL, facts_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, payload BLOB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','blocked_auth','blocked_permission','terminal_error','cancelled')),
  response_id TEXT, reason TEXT, updated_at TEXT NOT NULL, prune_after TEXT,
  UNIQUE(project_id, prompt_revision, source, listing_id, facts_hash)
);
CREATE TABLE IF NOT EXISTS run_deliveries(
  run_id TEXT NOT NULL REFERENCES runs(id), delivery_id INTEGER NOT NULL REFERENCES deliveries(id), carried_from TEXT,
  PRIMARY KEY(run_id, delivery_id)
);
CREATE TABLE IF NOT EXISTS reports(
  run_id TEXT PRIMARY KEY REFERENCES runs(id), outcome TEXT NOT NULL, body BLOB NOT NULL, frozen_at TEXT NOT NULL
);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class State:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        row = self.db.execute("SELECT version FROM schema_meta").fetchone()
        if row is None:
            self.db.execute("INSERT INTO schema_meta VALUES (?)", (SCHEMA_VERSION,))
        elif row[0] != SCHEMA_VERSION:
            raise RuntimeError("unsupported state database version")
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.db:
            yield self.db

    def start_run(
        self, run_id: str, mode: str, due_date: Optional[str], refs: Iterable[Dict[str, Any]]
    ) -> bool:
        try:
            with self.transaction() as db:
                db.execute(
                    "INSERT INTO runs(id,mode,due_date,phase,started_at) VALUES(?,?,?,?,?)",
                    (run_id, mode, due_date, "snapshot", utcnow()),
                )
                for ref in refs:
                    db.execute(
                        """INSERT INTO run_queries(
                      run_id,project_id,prompt_revision,prompt_hash,query_id,query_revision,query_hash,adapter,validator_version
                    ) VALUES(?,?,?,?,?,?,?,?,?)""",
                        (
                            run_id,
                            str(ref["project_id"]),
                            str(ref["prompt_revision"]),
                            ref["prompt_hash"],
                            str(ref["query_id"]),
                            str(ref["query_revision"]),
                            ref["query_hash"],
                            ref["adapter"],
                            ref["validator_version"],
                        ),
                    )
            return True
        except sqlite3.IntegrityError:
            if mode == "scheduled" and due_date is not None:
                existing = self.db.execute(
                    "SELECT 1 FROM runs WHERE mode='scheduled' AND due_date=? LIMIT 1",
                    (due_date,),
                ).fetchone()
                if existing is not None:
                    return False
            raise

    def recovery_candidate(self, due_date: str) -> Optional[sqlite3.Row]:
        """Return the same-day invocation that may continue before acquisition began or after a crash."""
        return self.db.execute(
            """SELECT * FROM runs WHERE mode='scheduled' AND due_date=?
            AND outcome<>'completed' AND error_class IN ('interrupted','startup','timeout','authentication','configuration')
            ORDER BY started_at DESC LIMIT 1""",
            (due_date,),
        ).fetchone()

    def start_recovery(
        self,
        run_id: str,
        previous_run_id: str,
        due_date: str,
        refs: Iterable[Dict[str, Any]],
    ) -> bool:
        """Transfer one calendar-day claim to a replacement invocation atomically."""
        try:
            with self.transaction() as db:
                changed = db.execute(
                    "UPDATE runs SET due_date=NULL WHERE id=? AND due_date=?",
                    (previous_run_id, due_date),
                ).rowcount
                if changed != 1:
                    raise sqlite3.IntegrityError("scheduled recovery lost its due-date claim")
                db.execute(
                    "INSERT INTO runs(id,mode,due_date,phase,started_at) VALUES(?,?,?,?,?)",
                    (run_id, "scheduled", due_date, "snapshot", utcnow()),
                )
                for ref in refs:
                    db.execute(
                        """INSERT INTO run_queries(
                      run_id,project_id,prompt_revision,prompt_hash,query_id,query_revision,query_hash,adapter,validator_version
                    ) VALUES(?,?,?,?,?,?,?,?,?)""",
                        (
                            run_id,
                            str(ref["project_id"]),
                            str(ref["prompt_revision"]),
                            ref["prompt_hash"],
                            str(ref["query_id"]),
                            str(ref["query_revision"]),
                            ref["query_hash"],
                            ref["adapter"],
                            ref["validator_version"],
                        ),
                    )
            return True
        except sqlite3.IntegrityError:
            return False

    def reuse_completed_queries(self, run_id: str, previous_run_id: str) -> None:
        """Attach already-durable batches to a crash-recovery run without fetching them again."""
        with self.transaction() as db:
            current_rows = list(db.execute("SELECT * FROM run_queries WHERE run_id=?", (run_id,)))
            for current in current_rows:
                previous = db.execute(
                    """SELECT * FROM run_queries WHERE run_id=? AND project_id=?
                    AND prompt_revision=? AND query_id=? AND query_revision=?
                    AND validator_version=? AND status='completed'""",
                    (
                        previous_run_id,
                        current["project_id"],
                        current["prompt_revision"],
                        current["query_id"],
                        current["query_revision"],
                        current["validator_version"],
                    ),
                ).fetchone()
                if previous is None:
                    continue
                db.execute(
                    """UPDATE run_queries SET attempted=1,status='completed',batch_id=?
                    WHERE id=? AND status='pending'""",
                    (previous["batch_id"], current["id"]),
                )
                db.execute(
                    """INSERT OR IGNORE INTO query_observations(run_query_id,observation_id)
                    SELECT ?,observation_id FROM query_observations WHERE run_query_id=?""",
                    (current["id"], previous["id"]),
                )
                db.execute(
                    """INSERT OR IGNORE INTO run_candidates(
                    run_id,project_id,prompt_revision,observation_id,carried_from)
                    SELECT ?,?,?,observation_id,? FROM query_observations WHERE run_query_id=?""",
                    (
                        run_id,
                        current["project_id"],
                        current["prompt_revision"],
                        previous_run_id,
                        previous["id"],
                    ),
                )

    def set_server_id(self, run_id: str, server_id: str) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE runs SET server_run_id=? WHERE id=? AND server_run_id IS NULL",
                (server_id, run_id),
            )

    def phase(self, run_id: str, phase: str) -> None:
        with self.transaction() as db:
            db.execute("UPDATE runs SET phase=? WHERE id=?", (phase, run_id))

    def fail_run(self, run_id: str, error_class: str) -> None:
        with self.transaction() as db:
            db.execute("UPDATE runs SET error_class=? WHERE id=?", (error_class, run_id))

    def pending_queries(self, run_id: str) -> list[sqlite3.Row]:
        return list(
            self.db.execute(
                "SELECT * FROM run_queries WHERE run_id=? AND status='pending' ORDER BY id",
                (run_id,),
            )
        )

    def fail_query(self, query_row_id: int, error_class: str) -> None:
        allowed = {
            "authentication",
            "blocked",
            "unavailable",
            "malformed",
            "partial",
            "timeout",
            "redirect",
            "configuration",
            "invariant",
            "model_failed",
            "model_malformed",
            "model_unavailable",
            "permission",
            "startup",
        }
        if error_class not in allowed:
            raise ValueError("unknown query error class")
        status = {
            "authentication": "blocked",
            "timeout": "unavailable",
            "redirect": "malformed",
            "configuration": "blocked",
            "invariant": "malformed",
            "model_failed": "malformed",
            "model_malformed": "malformed",
            "model_unavailable": "unavailable",
            "permission": "blocked",
            "startup": "blocked",
        }.get(error_class, error_class)
        with self.transaction() as db:
            db.execute(
                "UPDATE run_queries SET status=?,error_class=? WHERE id=? AND status='pending'",
                (status, error_class, query_row_id),
            )

    def fail_match(self, run_id: str, observation_id: int, error_class: str) -> bool:
        """Expose a matcher obstruction on the source query that produced the observation."""
        if error_class not in {"model_failed", "model_malformed", "model_unavailable"}:
            raise ValueError("unknown matcher error class")
        status = "unavailable" if error_class == "model_unavailable" else "malformed"
        with self.transaction() as db:
            query_ids = [
                row[0]
                for row in db.execute(
                    """SELECT rq.id FROM run_queries rq
                    JOIN query_observations qo ON qo.run_query_id=rq.id
                    WHERE rq.run_id=? AND qo.observation_id=?""",
                    (run_id, observation_id),
                )
            ]
            if not query_ids:
                return False
            placeholders = ",".join("?" for _ in query_ids)
            db.execute(
                """UPDATE run_queries SET status=?,error_class=?
                WHERE run_id=? AND id IN (%s) AND status='completed'""" % placeholders,
                (status, error_class, run_id, *query_ids),
            )
            return True

    def attempt_query(self, query_row_id: int) -> None:
        with self.transaction() as db:
            db.execute(
                "UPDATE run_queries SET attempted=1 WHERE id=? AND status='pending'",
                (query_row_id,),
            )

    def complete_query(
        self,
        query: sqlite3.Row,
        batch_id: str,
        body: bytes,
        body_hash: str,
        observations: Iterable[Dict[str, Any]],
    ) -> None:
        now = utcnow()
        items = list(observations)
        with self.transaction() as db:
            db.execute(
                """INSERT INTO source_batches
                (id,query_id,query_revision,prompt_revision,validator_version,body,body_hash,item_count,completed_at)
                VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    batch_id,
                    query["query_id"],
                    query["query_revision"],
                    query["prompt_revision"],
                    query["validator_version"],
                    body,
                    body_hash,
                    len(items),
                    now,
                ),
            )
            for item in items:
                db.execute(
                    "INSERT OR IGNORE INTO candidates(source,listing_id,canonical_url) VALUES(?,?,?)",
                    (item["source"], item["listing_id"], item["canonical_url"]),
                )
                candidate_id = db.execute(
                    "SELECT id FROM candidates WHERE source=? AND listing_id=?",
                    (item["source"], item["listing_id"]),
                ).fetchone()[0]
                db.execute(
                    "INSERT OR IGNORE INTO observations(candidate_id,facts_hash,body,observed_at) VALUES(?,?,?,?)",
                    (candidate_id, item["facts_hash"], item["body"], item["observed_at"]),
                )
                db.execute(
                    """UPDATE observations SET body=?,observed_at=?,prune_after=NULL
                    WHERE candidate_id=? AND facts_hash=? AND body IS NULL""",
                    (item["body"], item["observed_at"], candidate_id, item["facts_hash"]),
                )
                observation_id = db.execute(
                    "SELECT id FROM observations WHERE candidate_id=? AND facts_hash=?",
                    (candidate_id, item["facts_hash"]),
                ).fetchone()[0]
                db.execute(
                    "INSERT OR IGNORE INTO query_observations VALUES(?,?)",
                    (query["id"], observation_id),
                )
                db.execute(
                    """INSERT OR IGNORE INTO run_candidates
                    (run_id,project_id,prompt_revision,observation_id) VALUES(?,?,?,?)""",
                    (
                        query["run_id"],
                        query["project_id"],
                        query["prompt_revision"],
                        observation_id,
                    ),
                )
            db.execute(
                """INSERT INTO source_freshness VALUES(?,?,?,?,?,?)
                ON CONFLICT(query_id,query_revision,prompt_revision,validator_version) DO UPDATE SET
                batch_id=excluded.batch_id,completed_at=excluded.completed_at""",
                (
                    query["query_id"],
                    query["query_revision"],
                    query["prompt_revision"],
                    query["validator_version"],
                    batch_id,
                    now,
                ),
            )
            db.execute(
                """UPDATE run_queries SET attempted=1,status='completed',batch_id=?
                WHERE id=? AND status='pending'""",
                (batch_id, query["id"]),
            )

    def pending_candidates(self, run_id: str) -> list[sqlite3.Row]:
        return list(
            self.db.execute(
                """SELECT rc.*,o.body,o.facts_hash,c.source,c.listing_id,c.canonical_url
          FROM run_candidates rc JOIN observations o ON o.id=rc.observation_id
          JOIN candidates c ON c.id=o.candidate_id WHERE rc.run_id=? AND rc.status='pending' ORDER BY rc.id""",
                (run_id,),
            )
        )

    def decide_candidate(
        self, candidate_id: int, disposition: str, reason: str, unknowns: Iterable[str]
    ) -> None:
        if disposition not in {"kept", "rejected", "insufficient"}:
            raise ValueError("invalid disposition")
        with self.transaction() as db:
            db.execute(
                """UPDATE run_candidates SET status=?,reason=?,unknowns=?,decided_at=?
              WHERE id=? AND status='pending'""",
                (
                    disposition,
                    reason,
                    json.dumps(sorted(set(unknowns)), separators=(",", ":")),
                    utcnow(),
                    candidate_id,
                ),
            )

    def prior_disposition(
        self, project_id: str, prompt_revision: str, observation_id: int, excluding_run: str
    ) -> Optional[sqlite3.Row]:
        return self.db.execute(
            """SELECT status,reason,unknowns FROM run_candidates
          WHERE project_id=? AND prompt_revision=? AND observation_id=? AND run_id<>?
          AND status IN ('kept','rejected','insufficient') ORDER BY decided_at DESC LIMIT 1""",
            (project_id, prompt_revision, observation_id, excluding_run),
        ).fetchone()

    def ensure_delivery(
        self, run_id: str, candidate: sqlite3.Row, payload: bytes, key: str
    ) -> None:
        now = utcnow()
        with self.transaction() as db:
            db.execute(
                """INSERT OR IGNORE INTO deliveries
              (project_id,prompt_revision,source,listing_id,facts_hash,idempotency_key,payload,updated_at)
              VALUES(?,?,?,?,?,?,?,?)""",
                (
                    candidate["project_id"],
                    candidate["prompt_revision"],
                    candidate["source"],
                    candidate["listing_id"],
                    candidate["facts_hash"],
                    key,
                    payload,
                    now,
                ),
            )
            delivery_id = db.execute(
                "SELECT id FROM deliveries WHERE idempotency_key=?", (key,)
            ).fetchone()[0]
            db.execute(
                "INSERT OR IGNORE INTO run_deliveries(run_id,delivery_id) VALUES(?,?)",
                (run_id, delivery_id),
            )

    def pending_deliveries(self, run_id: str) -> list[sqlite3.Row]:
        return list(
            self.db.execute(
                """SELECT d.* FROM deliveries d JOIN run_deliveries rd ON rd.delivery_id=d.id
          WHERE rd.run_id=? AND d.status IN ('pending','blocked_auth','blocked_permission') ORDER BY d.id""",
                (run_id,),
            )
        )

    def update_delivery(
        self,
        delivery_id: int,
        status: str,
        response_id: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> None:
        if status not in {
            "pending",
            "acknowledged",
            "blocked_auth",
            "blocked_permission",
            "terminal_error",
            "cancelled",
        }:
            raise ValueError("invalid delivery status")
        with self.transaction() as db:
            now = datetime.now(timezone.utc)
            prune_after = (
                (now + timedelta(hours=48)).isoformat()
                if status in {"acknowledged", "terminal_error", "cancelled"}
                else None
            )
            db.execute(
                "UPDATE deliveries SET status=?,response_id=?,reason=?,updated_at=?,prune_after=? WHERE id=?",
                (status, response_id, reason, now.isoformat(), prune_after, delivery_id),
            )

    def derive(self, run_id: str) -> Dict[str, Any]:
        run_row = self.db.execute(
            "SELECT phase,error_class FROM runs WHERE id=?", (run_id,)
        ).fetchone()
        if run_row is None:
            raise ValueError("unknown run")
        query_rows = list(
            self.db.execute(
                "SELECT query_id,attempted,status,error_class FROM run_queries WHERE run_id=? ORDER BY id",
                (run_id,),
            )
        )
        candidate_rows = list(
            self.db.execute("SELECT status FROM run_candidates WHERE run_id=?", (run_id,))
        )
        delivery_rows = list(
            self.db.execute(
                """SELECT d.status FROM deliveries d
            JOIN run_deliveries rd ON rd.delivery_id=d.id WHERE rd.run_id=?""",
                (run_id,),
            )
        )
        missing_deliveries = self.db.execute(
            """SELECT count(*) FROM run_candidates rc
            JOIN observations o ON o.id=rc.observation_id
            JOIN candidates c ON c.id=o.candidate_id
            WHERE rc.run_id=? AND rc.status='kept' AND NOT EXISTS(
              SELECT 1 FROM deliveries d JOIN run_deliveries rd ON rd.delivery_id=d.id
              WHERE rd.run_id=rc.run_id AND d.project_id=rc.project_id
              AND d.prompt_revision=rc.prompt_revision AND d.source=c.source
              AND d.listing_id=c.listing_id AND d.facts_hash=o.facts_hash
            )""",
            (run_id,),
        ).fetchone()[0]
        counts = {
            "source_queries_total": len(query_rows),
            "source_queries_attempted": sum(row["status"] != "pending" for row in query_rows),
            "source_queries_completed": sum(row["status"] == "completed" for row in query_rows),
            "candidates_observed": len(candidate_rows),
            "candidates_evaluated": sum(row["status"] != "pending" for row in candidate_rows),
            "candidates_kept": sum(row["status"] == "kept" for row in candidate_rows),
            "candidates_insufficient": sum(
                row["status"] == "insufficient" for row in candidate_rows
            ),
            "deliveries_acknowledged": sum(
                row["status"] == "acknowledged" for row in delivery_rows
            ),
            "deliveries_pending": sum(
                row["status"] in {"pending", "blocked_auth", "blocked_permission"}
                for row in delivery_rows
            )
            + missing_deliveries,
        }
        terminal_error = any(row["status"] == "terminal_error" for row in delivery_rows)
        complete = bool(query_rows) and all(row["status"] == "completed" for row in query_rows)
        complete = complete and all(row["status"] != "pending" for row in candidate_rows)
        complete = complete and all(
            row["status"] in {"acknowledged", "cancelled"} for row in delivery_rows
        )
        complete = complete and missing_deliveries == 0
        complete = complete and counts["deliveries_acknowledged"] == counts["candidates_kept"]
        run_error = run_row["error_class"]
        useful = bool(
            counts["source_queries_attempted"]
            or counts["candidates_observed"]
            or counts["deliveries_acknowledged"]
            or counts["deliveries_pending"]
        )
        outcome = (
            "failed"
            if terminal_error
            or run_error
            in {
                "startup",
                "timeout",
                "authentication",
                "configuration",
                "invariant",
                "model_failed",
                "model_malformed",
                "model_unavailable",
            }
            or (run_error == "interrupted" and not useful)
            else ("completed" if complete else "incomplete")
        )
        report = {
            "status": outcome,
            "phase": "finish",
            "counts": counts,
            "queries": [],
            "failure": None,
        }
        for row in query_rows:
            query = {
                "source_query_revision_id": row["query_id"],
                "status": row["status"],
            }
            error_class = row["error_class"]
            if row["status"] != "completed" and not error_class:
                error_class = "incomplete"
            if error_class:
                query["error_class"] = error_class
            report["queries"].append(query)
        failure_code = "delivery_terminal" if terminal_error else run_error
        if outcome == "failed":
            report["failure"] = {
                "phase": run_row["phase"],
                "code": failure_code or "invariant",
            }
        return report

    def freeze_report(self, run_id: str) -> Dict[str, Any]:
        report = self.derive(run_id)
        body = json.dumps(report, sort_keys=True, separators=(",", ":")).encode()
        prune_after = (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat()
        with self.transaction() as db:
            db.execute(
                "INSERT OR IGNORE INTO reports VALUES(?,?,?,?)",
                (run_id, report["status"], body, utcnow()),
            )
            db.execute(
                "UPDATE runs SET phase='finish',outcome=?,finished_at=? WHERE id=?",
                (report["status"], utcnow(), run_id),
            )
            db.execute(
                """UPDATE observations SET prune_after=? WHERE id IN (
              SELECT rc.observation_id FROM run_candidates rc WHERE rc.run_id=? AND rc.status<>'pending'
            ) AND NOT EXISTS(SELECT 1 FROM run_candidates pending
              WHERE pending.observation_id=observations.id AND pending.status='pending')
              AND NOT EXISTS(SELECT 1 FROM deliveries d JOIN candidates c ON c.source=d.source AND c.listing_id=d.listing_id
                WHERE c.id=observations.candidate_id AND d.facts_hash=observations.facts_hash
                AND d.status IN ('pending','blocked_auth','blocked_permission'))
              AND NOT EXISTS(SELECT 1 FROM run_candidates kept
                WHERE kept.observation_id=observations.id AND kept.status='kept' AND NOT EXISTS(
                  SELECT 1 FROM candidates c JOIN deliveries d
                    ON d.source=c.source AND d.listing_id=c.listing_id
                  JOIN run_deliveries rd ON rd.delivery_id=d.id AND rd.run_id=kept.run_id
                  WHERE c.id=observations.candidate_id AND d.project_id=kept.project_id
                  AND d.prompt_revision=kept.prompt_revision AND d.facts_hash=observations.facts_hash
                ))""",
                (prune_after, run_id),
            )
            db.execute(
                """UPDATE source_batches SET prune_after=? WHERE id IN (
              SELECT rq.batch_id FROM run_queries rq WHERE rq.run_id=? AND rq.status='completed'
            ) AND NOT EXISTS(SELECT 1 FROM run_queries rq JOIN query_observations qo ON qo.run_query_id=rq.id
              JOIN run_candidates rc ON rc.observation_id=qo.observation_id
              WHERE rq.batch_id=source_batches.id AND rc.status='pending')
              AND NOT EXISTS(SELECT 1 FROM run_queries rq JOIN query_observations qo ON qo.run_query_id=rq.id
                JOIN observations o ON o.id=qo.observation_id JOIN candidates c ON c.id=o.candidate_id
                JOIN deliveries d ON d.source=c.source AND d.listing_id=c.listing_id AND d.facts_hash=o.facts_hash
                WHERE rq.batch_id=source_batches.id AND d.status IN ('pending','blocked_auth','blocked_permission'))
              AND NOT EXISTS(SELECT 1 FROM run_queries rq
                JOIN query_observations qo ON qo.run_query_id=rq.id
                JOIN observations o ON o.id=qo.observation_id
                JOIN candidates c ON c.id=o.candidate_id
                JOIN run_candidates kept ON kept.run_id=rq.run_id
                  AND kept.observation_id=o.id AND kept.status='kept'
                WHERE rq.batch_id=source_batches.id AND NOT EXISTS(
                  SELECT 1 FROM deliveries d JOIN run_deliveries rd
                    ON rd.delivery_id=d.id AND rd.run_id=kept.run_id
                  WHERE d.project_id=kept.project_id AND d.prompt_revision=kept.prompt_revision
                  AND d.source=c.source AND d.listing_id=c.listing_id AND d.facts_hash=o.facts_hash
                ))""",
                (prune_after, run_id),
            )
        return report

    def interrupt_open_runs(self) -> list[str]:
        ids = [
            row[0]
            for row in self.db.execute(
                "SELECT id FROM runs WHERE outcome IS NULL ORDER BY started_at"
            )
        ]
        for run_id in ids:
            with self.transaction() as db:
                db.execute(
                    "UPDATE runs SET error_class='interrupted' WHERE id=?",
                    (run_id,),
                )
                db.execute(
                    """UPDATE run_queries SET status=CASE attempted WHEN 1 THEN 'partial' ELSE 'blocked' END,
                  error_class='interrupted' WHERE run_id=? AND status='pending'""",
                    (run_id,),
                )
            self.freeze_report(run_id)
        return ids

    def carry_work(self, run_id: str, active: Dict[str, str]) -> None:
        """Attach retryable work only when the project's exact prompt revision remains current."""
        with self.transaction() as db:
            candidates = list(
                db.execute(
                    """SELECT rc.* FROM run_candidates rc JOIN runs r ON r.id=rc.run_id
              WHERE rc.status='pending' AND rc.run_id<>?""",
                    (run_id,),
                )
            )
            for row in candidates:
                if active.get(row["project_id"]) == row["prompt_revision"]:
                    db.execute(
                        """INSERT OR IGNORE INTO run_candidates
                      (run_id,project_id,prompt_revision,observation_id,carried_from) VALUES(?,?,?,?,?)""",
                        (
                            run_id,
                            row["project_id"],
                            row["prompt_revision"],
                            row["observation_id"],
                            row["run_id"],
                        ),
                    )
                    db.execute(
                        """UPDATE run_candidates SET status='cancelled',reason='carried',decided_at=?
                      WHERE id=? AND status='pending'""",
                        (utcnow(), row["id"]),
                    )
                else:
                    db.execute(
                        "UPDATE run_candidates SET status='cancelled',reason='superseded',decided_at=? WHERE id=?",
                        (utcnow(), row["id"]),
                    )
            deliveries = list(
                db.execute(
                    """SELECT d.*,rd.run_id source_run FROM deliveries d
              JOIN run_deliveries rd ON rd.delivery_id=d.id
              WHERE d.status IN ('pending','blocked_auth','blocked_permission') AND rd.run_id<>?""",
                    (run_id,),
                )
            )
            for row in deliveries:
                if active.get(row["project_id"]) == row["prompt_revision"]:
                    db.execute(
                        "INSERT OR IGNORE INTO run_deliveries VALUES(?,?,?)",
                        (run_id, row["id"], row["source_run"]),
                    )
                else:
                    reason = (
                        "project_no_longer_applicable"
                        if row["project_id"] not in active
                        else "superseded"
                    )
                    now = datetime.now(timezone.utc)
                    db.execute(
                        "UPDATE deliveries SET status='cancelled',reason=?,updated_at=?,prune_after=? WHERE id=?",
                        (
                            reason,
                            now.isoformat(),
                            (now + timedelta(hours=48)).isoformat(),
                            row["id"],
                        ),
                    )

    def acknowledge_report(self, run_id: str) -> None:
        with self.transaction() as db:
            db.execute("UPDATE runs SET server_report='acknowledged' WHERE id=?", (run_id,))

    def unfinished_reports(self) -> list[sqlite3.Row]:
        return list(
            self.db.execute("""SELECT r.*,p.body report_body FROM runs r LEFT JOIN reports p ON p.run_id=r.id
          WHERE r.server_report='pending' ORDER BY r.started_at""")
        )

    def prune(self, now: str, limit: int = 500) -> Dict[str, int]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 5000:
            raise ValueError("prune limit must be between 1 and 5000")
        with self.transaction() as db:
            obs = db.execute(
                """UPDATE observations SET body=NULL WHERE id IN (
              SELECT id FROM observations candidate WHERE candidate.body IS NOT NULL
              AND candidate.prune_after<=? AND NOT EXISTS(
                SELECT 1 FROM run_candidates rc WHERE rc.observation_id=candidate.id
                AND rc.status='pending') ORDER BY candidate.prune_after LIMIT ?)""",
                (now, limit),
            ).rowcount
            batches = db.execute(
                """UPDATE source_batches SET body=NULL WHERE id IN (
                SELECT id FROM source_batches WHERE body IS NOT NULL AND prune_after<=?
                ORDER BY prune_after LIMIT ?)""",
                (now, limit),
            ).rowcount
            deliveries = db.execute(
                """UPDATE deliveries SET payload=NULL WHERE id IN (
              SELECT id FROM deliveries WHERE payload IS NOT NULL AND prune_after<=?
              AND status IN ('acknowledged','terminal_error','cancelled')
              ORDER BY prune_after LIMIT ?)""",
                (now, limit),
            ).rowcount
        return {"observations": obs, "batches": batches, "deliveries": deliveries}
