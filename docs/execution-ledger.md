# Rewrite execution ledger

Planning ceiling: 12,000,000 estimated processed tokens. Estimates are committed at dispatch and
are never revised downward.

| Task | Acceptance | Model | Estimate | State | Branch/worktree | Result |
|---|---|---:|---:|---|---|---|
| Foundation inventory and specification | Contracts locked | Sol | 700,000 | complete | main | `b2b3c3f..88ae550` |
| Auth/session/pairing vertical slice | Focused tests and mountable router | Luna x-high | 900,000 | complete | feat/auth-core | Integrated locally; auth + live PostgreSQL gates pass |
| Project/lead collaboration slice | Focused tests and mountable router | Luna x-high | 1,200,000 | complete | feat/collaboration-core | Integrated locally; collaboration + concurrency gates pass |
| Runs/change-feed/kit slice | Focused tests and mountable router | Luna x-high | 1,100,000 | complete | feat/agent-core | `ba303da`; 12 tests + full check |
| React core journeys | Login, projects, leads, settings, and agent setup shell | Sol | 900,000 | complete | main | Integrated locally; 6 desktop/mobile browser journeys pass |
| Agent/API adversarial review | Acceptance 42–63 and SQL/security audit | Sol | 300,000 | complete | review-only | Findings integrated; production adapters and unchanged-client path pass |

Committed estimate: **5,100,000**

This is a conservative dispatch ledger, not measured subscription usage.

## Capacity snapshot

`$codex-usage` at 2026-08-20T19:01:03Z reported the general Codex pool at 84% remaining in its
7-day window, resetting 2026-08-26T18:55:22Z. It exposed no 5-hour or monthly window for that pool.
The separately metered Spark pool was unused and is not counted as general-pool headroom. Recheck
before every new dispatch; this snapshot is historical only.

The post-agent checkpoint at 2026-08-20T19:55:57Z reported 76% remaining in the general 7-day
window. No general 5-hour or monthly meter was exposed.

The post-integration checkpoint at 2026-08-20T20:49:50Z reported 69% remaining in the general
7-day window. No general 5-hour or monthly meter was exposed; no further workers were dispatched.

The final local-gate checkpoint at 2026-08-20T21:12:02Z reported 67% remaining in the general
7-day window, above the 53% dispatch stop and 50% hard floor. No general 5-hour or monthly meter
was exposed.

## Local integration gates

- `bun run check`: 38 tests passed, 6 live-database tests skipped by default, typecheck/lint/API
  inventory/build green.
- Live PostgreSQL: 6 tests passed, covering concurrency, migration, invitation rollback, device
  polling, and the unchanged Python client.
- Playwright: 6 journeys passed across desktop Chromium and Pixel 7 profiles.
- Caddy: pinned 2.9.1 image accepted the production Caddyfile.
- Performance profiling remains deferred until the functional cutover candidate is complete.

## Legacy evidence

The Django suite was run once without its cache provider: 302 tests and 450 subtests passed in
61.98 seconds. It is behavioral evidence, not a replacement acceptance gate, and will not be
ported wholesale.

## v2 port qualification record — 2026-08-29

The recorded production baseline before the port was commit `e66cb23`, image
`sha256:a34b7cbbd526e9928c448f935df48da2c5c58bbbfb7e0430f7cd413b9727f13a`, verified healthy, with
served manifest digest
`a8ff9195f2c0719c5f24052010377a58d1853a948769e8d7ac2611672c88a8ba`.

Completed local evidence:

- The reviewed vendored runner passed all 53 reviewed core tests through the import-remap harness;
  its source artifact digest was
  `7b8ceaa4152c7945d5b16cebaadf905cdc1d5639bd7e107008c5cb6054781c42`.
- The real vendored Python client passed 4/4 Hono contract scenarios: discovery, exact-byte reads,
  run creation/finalization, delivery, introspection, and disconnect.
- The TypeScript-built production-origin package is version 2 with 19 members and a 50,103-byte
  archive, reproducible across two builds; archive SHA-256 is
  `7a148e8428f863cc1996ab31f212e16c92e8b49148857a853230fc647ea7d4df`.
- Focused server, client, browser, typecheck, lint, and generated API checks passed on the port
  commits.

## Final qualification record — commit `f05b673`

- Local `bun run check` passed with 131 active tests and 21 PostgreSQL-gated skips; build,
  typecheck, lint, and generated API checks passed.
- The committed Python package suite passed 11/11 tests.
- `bun run test:agentation` passed 22/22 Chromium UI tests, including the v2 lifecycle-state test.
- An isolated deployment-host rehearsal used disposable PostgreSQL 17 and the pinned production
  Dockerfile build, applied migrations twice, and passed all 21 PostgreSQL integration tests.
- The prior image
  `sha256:a34b7cbbd526e9928c448f935df48da2c5c58bbbfb7e0430f7cd413b9727f13a` served healthy HTML
  against the expanded schema. A streaming age-encrypted backup, isolated restore, repeated
  migrations, and new-image health/HTML checks passed.
- The encrypted rehearsal artifact SHA-256 was
  `66467d1927bd53d17505b9f68d8881bbe7b4fca3a90cbb006ab9ce3c0b2e09fa` before automatic cleanup.
  Production was untouched. Package/server adversarial blockers were fixed, obsolete local
  rollback was removed, and initial harness runtime/container failures were resolved without
  product-level failure claims.

Qualification blockers and non-claims:

- Native-Mac branches not explicitly exercised remain unqualified: a physical macOS install or
  wake test and the production canary remain post-deploy/manual gates. They do not block code being
  ready to deploy, but they do block declaring the production rollout proven. The disabled and
  archived `com.homing.backup` LaunchAgent is not treated as a running or protected schedule.
