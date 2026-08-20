# Rewrite orchestration

One Sol integrator owns `main`. Workers use isolated worktrees and bounded vertical slices. Schema,
authentication contracts, and app mounting are integrated serially. Only the integrator merges a
slice after focused tests pass.

## Capacity gate

`$codex-usage` is the authoritative dispatch meter. At the start of every orchestrator turn, after
each worker result, and at least every 20 minutes while workers run, invoke:

```sh
bun --no-env-file ~/.codex/skills/codex-usage/scripts/codex-usage.ts --json
```

Apply floors to the rate limit for the model pool actually doing the work. A separately listed
model pool does not provide capacity to another pool.

| Window | Stop new dispatch at remaining | Hard stop at remaining |
|---|---:|---:|
| 5 hour, when reported | 45% | 35% |
| 7 day | 53% | 50% |
| Monthly, when reported | 78% | 75% |

If a window is absent, it is unavailable and no threshold is inferred. If a run begins below a
floor, migration work waits for reset unless Hart explicitly reallocates headroom. Already-bounded
atomic integration may finish between the dispatch and hard-stop thresholds. Never dispatch work
whose recent burn projects across a hard floor before the next check. There is no daily cap.

Rate-limit percentages govern scheduling. Account token activity and current-thread token counters
are diagnostic and are not convertible to subscription allowance. The 12M dispatch ledger remains
a conservative planning ceiling, not measured usage.

## Run ownership

Only one integrator turn may dispatch or merge at once. A scheduled continuation must first confirm
that no earlier integrator or worker is live, inspect every worktree, and reconcile completed
branches. If that cannot be established, it exits without dispatching. Remote staging requires
preapproved commands and no agent handling of secrets; production cutover always requires Hart.
