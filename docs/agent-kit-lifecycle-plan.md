# Agent-kit v2 lifecycle plan

Date: 2026-08-29

Status: normative lifecycle for the TypeScript port; native and database qualification pending.

## Lifecycle contract

The public entry is an attended setup prompt. It is not an installed skill. The package contains
top-level `SETUP.md` with no Agent Skill frontmatter; `homing-check/SKILL.md` is the only optional
durable skill. The scheduled worker is generated configuration, scripts, state, and one scheduler
entry outside skill roots.

The lifecycle has one installation, one runner, one schedule, one private operational ledger, and
one Homing source of truth. Setup, daily execution, refresh, pause, disconnect, and removal have
distinct authority. No v1 local installation, local prompt replica, second schedule, or Django
deployment is a supported rollback or lifecycle step.

## Durable boundaries

- Homing stores prompt text, confirmed requirements, acquisition basis, source-query revisions,
  connection authority, run reports, leads, observations, audit, and idempotency.
- The local SQLite ledger stores only revision IDs/hashes and recoverable acquisition, disposition,
  delivery, acknowledgement, and crash-recovery state. Prompt and source payloads do not persist
  there.
- The install manifest records only durable worker files, the optional `homing-check` facade,
  credential identifier, and the one scheduler entry.
- Matching receives bounded facts and a fixed task prompt. It has no Homing credential, network,
  shell, source, or persistent-instruction authority.
- The scheduler invokes only the generated worker. The worker cannot rewrite its prompt, cadence,
  sources, executable code, or permissions.

## Setup and cleanup

1. Fetch a fresh package from the TypeScript-owned `/agent/` origin and verify origin, manifest,
   archive, hashes, bounds, and package marker.
2. Discover only the supported host capabilities, pair through browser approval, and configure each
   project with confirmed requirements and bounded source queries.
3. Create or adopt exactly one manifest-owned installation and one legibly named job. Re-running
   setup repairs or replaces that installation; it never layers another one.
4. Run self-test and the first real check. A scheduled invocation that returns `paused` is valid
   no-work only when the ledger proves it created no due marker, acquisition, disposition,
   delivery, or Homing write.
5. After success, delete only the verified temporary setup workspace: manifest-listed files,
   archive, marker, and now-empty package directories. Refuse broad, ambiguous, synced, home,
   repository, or skill-root paths and report unexpected residue. Cleanup is idempotent.

The package is temporary even when downloaded beneath a skill directory. It must not leave setup
guidance discoverable there. A failed setup rolls back only durable files it can prove it owns and
reports anything else.

## Daily run

At invocation start, the runner reads pause state, active memberships, immutable v2 revisions, and
approved source metadata. It exits before acquisition when paused, disconnected, or any project
needs configuration. It persists source batches before freshness, evaluates bounded facts with
deterministic constraints before model judgment, writes one disposition per observation, and
delivers kept candidates through idempotent create-or-return-existing calls.

Every interruption preserves nonterminal work. `nothing found` is valid only after all snapshotted
queries, candidates, dispositions, and kept deliveries are terminal and no required fact is
`unknown`. Otherwise the run is incomplete or failed with the obstructing phase/query. The server
report is immutable after its structurally valid terminal form.

## Refresh, pause, disconnect, and removal

- A text-only prompt edit creates a new immutable revision carrying forward confirmed requirements
  and query references. Acquisition-field edits require browser-attended source refresh and mark
  replacement queries `needs_review` until confirmed.
- Setup receives a temporary source-write grant: 30 minutes initially, consumed at finalization;
  browser repair may grant 15 minutes on the same owned connection.
- Pause is a user-wide reversible 14-day state. It stops remote work without uninstalling.
- Disconnect revokes only the calling Homing connection. The web app states that it cannot delete
  local files and offers a copyable removal action.
- Local removal stops the one job, removes the credential and manifest-owned files, preserves
  unrelated data, and reports residue. It may also disconnect remote access when available.

## Qualification and ownership

The TypeScript repository owns package serving and production bytes. Qualification exercises the
complete Python v2 runner against Hono/PostgreSQL, deterministic package output, lifecycle cleanup,
pause/resume, disconnect, delivery retry, backup/restore, and prior-TypeScript-image rollback.
The native Mac canary qualifies only behaviors actually exercised on that host. Unsupported setup
agents, hosts, and uninduced crash or repair branches remain explicitly unverified.

The lifecycle is complete only when no setup artifact remains after success, `homing-setup` is
absent from skill inventories, exactly one worker and schedule remain, all state shown by the UI
agrees with durable records, and the local v1 residue has been removed. The former backup
LaunchAgent is disabled and archived; it is not an active protected schedule and must not be
recreated or represented as running by this lifecycle.
