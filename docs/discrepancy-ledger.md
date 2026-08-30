# v2 behavioral discrepancy ledger

Every conflict receives `keep`, `change`, or `defer` before the affected implementation begins.
The reviewed v2 agent-kit and search contract is authoritative, followed by the build specification
and acceptance matrix, existing TypeScript product behavior outside this contract, the Django v2
implementation as evidence, and v1 behavior as rollback evidence only.

| Area | Existing assumption or evidence | v2 decision | Rationale |
|---|---|---|---|
| Contract precedence | The repository treated the unchanged v1 package as highest precedence | change | The reviewed v2 contract now governs the port; v1 is rollback evidence only. |
| Server ownership | Django was the replacement source and rollback target | change | TypeScript is already production and remains the canonical server, package publisher, and deployment target. No Django importer or deployment rollback is part of this port. |
| Local v1 state | A failed v1 installation could be treated as a rollback install | change | It is cleanup residue. Remove its job, runtime/config/state, skill copies, logs, installer backups, and credential metadata. The former `com.homing.backup` LaunchAgent is disabled and archived, not an active protected job. |
| Local configuration | A second local prompt/source replica could support runtime | change | Homing is the sole source of current prompt, requirements, acquisition basis, and source configuration. SQLite stores only recoverable work and delivery state. |
| Setup artifact | A top-level setup `SKILL.md` could be installed or persisted | change | Use top-level `SETUP.md` with no skill frontmatter. Only the optional installed `homing-check/SKILL.md` is durable; legacy setup URLs redirect without adding an archive member. |
| Configuration model | Prompt prose and legacy rows could supply runtime requirements | change | Add complete immutable v2 revisions, explicit evidence and acquisition fields, immutable query revisions, exact canonical bytes, and hashes. Legacy revisions remain immutable and are never inferred from. |
| Schema migration | A Django data importer and empty target were required | change | Extend the existing PostgreSQL schema in place with an expand-only Drizzle migration. No Django data migration or second product database. |
| Run storage | v2 could overload leased v1 `search_runs` | change | Use a distinct v2 run table with invocation idempotency and truthful terminal reports; do not depend on v1 leases, claims, cursors, or continuation state. |
| Source changes | Acquisition edits could run against old queries | change | Revision query inputs by acquisition-basis hash; mark replacements `needs_review` and require attended refresh before acquisition. |
| Connection authority | A durable broad token or permanent setup write scope was acceptable | change | Pair as protocol v2, issue exactly the documented scopes, expire initial source-write authority after 30 minutes, consume it on finalization, and allow only browser-approved 15-minute refresh. |
| Pause semantics | Pause could be per connection or local-only | change | Keep a user-wide, reversible 14-day `paused_until`, visible in discovery and introspection and enforced before acquisition. |
| Delivery mutation | Generic lead upsert could update existing fields | change | Use a dedicated create-or-return-existing transaction keyed by stable identity; never overwrite human edits and record the match observation idempotently. |
| Setup cleanup | Temporary package residue could be left or broadly deleted | change | Finalize only a verified manifest-listed workspace, refuse ambiguous paths, report residue, and make a second cleanup a no-op. |
| Package source and digest | A Django archive or release digest could remain authoritative | change | TypeScript owns the package. Rebuild and requalify final production-origin bytes; preserve deterministic manifest/archive behavior. |
| Native gate | A discarded VM or disposable-user run was required | change | Use the isolated deployment-host rehearsal for database and container qualification. Record only paths actually exercised; this qualification claims no physical native-macOS install or wake test and no production canary. |
| Rollback | A local v1 search bundle or Django server restored all prior behavior | change | The obsolete local v1 rollback path is removed. Ordinary failure pauses/removes v2 locally and selects the prior TypeScript image; database restore is reserved for corruption. |
| Feedback and repair | Prompt self-modification, source-plan repair, or automatic repair could enter v2 | defer | Future feedback proposals remain an explicit user-approved extension. v2 exposes configuration state and attended source refresh only. |
