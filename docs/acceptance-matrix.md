# Homing agent kit v2 acceptance matrix

This matrix is the release gate for the v2 TypeScript port. Parameterization may combine cases;
scenario count is not normative. The reviewed v2 contract and this matrix supersede v1 execution
behavior. Existing product journeys remain gates only where they intersect the port.

The former `com.homing.backup` LaunchAgent is disabled and archived. It is not an active release
gate or protected schedule; backup qualification uses the documented manual command and an
explicitly recorded artifact.

Final qualification for commit `f05b673` passed the local `bun run check` with 131 active tests and
21 PostgreSQL-gated skips; build, typecheck, lint, and generated API checks were green. The
committed Python package suite passed 11/11, and the agentation suite passed 22/22 Chromium UI
tests, including the v2 lifecycle-state test. An isolated deployment-host rehearsal used
disposable PostgreSQL 17 and the pinned production Dockerfile build, applied migrations twice, and
passed all 21 PostgreSQL integration tests. The prior image
`sha256:a34b7cbbd526e9928c448f935df48da2c5c58bbbfb7e0430f7cd413b9727f13a` served healthy HTML
against the expanded schema; a streaming age-encrypted backup, isolated restore, repeated
migrations, and new-image health/HTML checks passed. The encrypted rehearsal artifact had SHA-256
`66467d1927bd53d17505b9f68d8881bbe7b4fca3a90cbb006ab9ce3c0b2e09fa` before automatic cleanup.
Production was untouched; package/server adversarial blockers were fixed and the obsolete local
rollback path was removed. The code is ready to deploy, but this record does not claim a physical
native macOS install or wake test or a production canary; those remain post-deploy/manual gates
for proving rollout.

## Contract and canonical state

1. The normative order names the reviewed v2 contract first; v1 is rollback evidence only.
2. The expand-only migration preserves all existing rows and leaves legacy prompt revisions
   immutable with null v2 pointers.
3. A complete configuration stores required evidence, acquisition basis, ordered query references,
   exact canonical UTF-8 bytes, and a matching SHA-256.
4. Retrieval returns the stored bytes unchanged with a strong SHA-256 ETag; it never reserializes.
5. Text-only edits carry forward confirmed requirements and query references in one transaction.
6. Acquisition-field edits create replacement queries marked `needs_review` and block unattended
   acquisition until attended refresh confirms them.
7. Cross-project access, revision conflicts, query bounds, immutability, and ordered references
   fail closed in database constraints and transaction code.

## Pairing, authority, and lifecycle

8. Pairing declares protocol v2, remains pending until browser approval, and discloses one
   credential and connection ID exactly once.
9. The initial credential has only the five documented v2 scopes; no account key appears in chat,
   arguments, ordinary config, state, model input, or logs.
10. Setup finalization consumes the 30-minute source-write grant; browser refresh grants the same
    connection 15 minutes and cannot alter another connection.
11. Introspection and disconnect are isolated to the calling credential; a revoked bearer returns
    401 and disconnect does not claim local file removal.
12. Pause is user-wide, reversible, lasts at most 14 days, and is visible in project discovery and
    introspection.
13. Project discovery returns every active membership as `ready` or `configuration: needed`, and
    a mixed project set never performs partial acquisition.
14. Re-running setup adopts, repairs, or replaces exactly one manifest-owned installation and one
    legibly named scheduler entry; a second cleanup is a no-op and unrelated files remain intact.
15. Successful setup removes only its verified temporary workspace and reports unexpected residue.

## Acquisition, matching, and delivery

16. A paused or disconnected run exits before acquisition and creates no due marker or work row.
17. Run creation snapshots immutable revisions and is idempotent by principal, project, and
    invocation UUID; a later config revision cannot alter that snapshot.
18. Each source batch is durable before freshness advances; interruption preserves pending work.
19. Every required evidence key is `present`, `absent`, or `unknown`; unknown required evidence
    yields `insufficient`, never a fabricated mismatch.
20. Deterministic constraints run before bounded model judgment; model transport has no Homing,
    source, shell, or persistent-instruction authority.
21. One disposition exists per project, prompt revision, candidate, and observation revision and
    is one of `pending`, `rejected`, `insufficient`, or `kept` with reason and named unknowns.
22. A malformed or partial model response writes no disposition and preserves pending work.
23. Delivery creates or returns the stable lead identity, records the observation idempotently, and
    never overwrites newer human-edited fields.
24. Delivery acknowledgement follows Homing confirmation; retryable auth/permission/availability
    failures remain blocked or pending, not delivered.
25. A terminal report is structurally valid and idempotent. `completed` has no nonterminal query,
    candidate, or delivery; incomplete work names its obstructing phase/query.
26. `nothing found` is emitted only when every snapshotted query completed, every candidate is
    terminal, every kept candidate is acknowledged, and none is `insufficient`.
27. Repeating delivery and finalization creates no duplicate lead, observation, or terminal report;
    cross-project delivery is rejected.

## Public package and real-client integration

28. `/agent/` serves v2 package members through an exact allowlist before the SPA catch-all;
    traversal cannot reach an unallowlisted path.
29. The package contains top-level `SETUP.md`, no top-level setup `SKILL.md`, and only the optional
    `homing-check/SKILL.md` durable skill.
30. Manifest fields, member digests/lines, archive metadata, origin substitution, content types,
    HEAD behavior, cache headers, and strong ETags are exact.
31. The deterministic archive is reproducible for a fixed origin and contains exactly the verified
    allowlisted members.
32. The complete Python v2 runner—not only a single client script—passes pair, configure, exact
    byte retrieval, acquisition/matching, delivery twice, finalization, pause/resume, disconnect,
    and 401 recovery against Hono and PostgreSQL.
33. The paused scheduled invocation returns `paused` only when the ledger proves no due marker,
    acquisition, disposition, delivery, or Homing write; self-test accepts that valid no-work
    outcome.

## Product, operations, and deployment

34. Browser UI shows configuration-needed state, confirmed sources/requirements, pause state,
    connection identity, refresh authority, and truthful run outcomes without source-plan repair
    or false healthy states.
35. Browser drafts survive optimistic conflicts; pause, disconnect, and local removal use factual,
    distinct controls and copy.
36. `bun run check`, focused policy tests, PostgreSQL integration, browser journeys, migration
    drift, API/route coverage, package verification, and Docker smoke pass on one clean commit.
37. Fresh encrypted PostgreSQL backup, isolated restore, previous-image browser/health/database
    smoke, and v2-image smoke all pass; restored data satisfies v2 constraints.
38. Production uses the existing TypeScript Compose topology: migrate before web recreation, keep
    Caddy/PostgreSQL private as required, and retain the prior TypeScript image through the
    rollback window.
39. Ordinary canary rollback pauses/removes the local v2 install and restores the prior TypeScript
    image; database restore is reserved for corruption. No Django or local v1-search rollback is
    claimed.
40. Native qualification records only behaviors actually exercised on Hart's Mac; unsupported
    hosts, setup agents, and uninduced crash/repair branches remain explicitly unverified.
