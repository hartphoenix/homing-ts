# Rewrite execution ledger

Planning ceiling: 12,000,000 estimated processed tokens. Estimates are committed at dispatch and
are never revised downward.

| Task | Acceptance | Model | Estimate | State | Branch/worktree | Result |
|---|---|---:|---:|---|---|---|
| Foundation inventory and specification | Contracts locked | Sol | 700,000 | complete | main | `b2b3c3f..88ae550` |
| Auth/session/pairing vertical slice | Focused tests and mountable router | Luna x-high | 900,000 | active | feat/auth-core | — |
| Project/lead collaboration slice | Focused tests and mountable router | Luna x-high | 1,200,000 | active | feat/collaboration-core | — |
| Runs/change-feed/kit slice | Focused tests and mountable router | Luna x-high | 1,100,000 | active | feat/agent-core | — |

Committed estimate: **3,900,000**

This is a conservative dispatch ledger, not measured subscription usage.

## Capacity snapshot

`$codex-usage` at 2026-08-20T19:01:03Z reported the general Codex pool at 84% remaining in its
7-day window, resetting 2026-08-26T18:55:22Z. It exposed no 5-hour or monthly window for that pool.
The separately metered Spark pool was unused and is not counted as general-pool headroom. Recheck
before every new dispatch; this snapshot is historical only.

## Legacy evidence

The Django suite was run once without its cache provider: 302 tests and 450 subtests passed in
61.98 seconds. It is behavioral evidence, not a replacement acceptance gate, and will not be
ported wholesale.
