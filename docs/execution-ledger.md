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
