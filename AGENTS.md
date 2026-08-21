# Homing repository guidance

## Product and stack

Homing is a collaborative housing-search application. Humans use the React interface; agents use
the versioned JSON API and public agent kit.

- Runtime and package manager: Bun
- Browser: React and Vite
- Server: Hono
- Database: PostgreSQL with Drizzle
- Validation: Zod
- Tests: Vitest and Playwright

Use TypeScript throughout the application. Keep dependencies minimal and code direct.

## Contracts

Treat these as the normative sources, in order:

1. Security and wire behavior required by the unchanged agent kit.
2. [docs/build-spec.md](docs/build-spec.md) and [docs/acceptance-matrix.md](docs/acceptance-matrix.md).
3. [docs/discrepancy-ledger.md](docs/discrepancy-ledger.md).
4. The generated OpenAPI document and route inventory.
5. The legacy Django implementation, when available, as behavioral evidence only.

Do not copy legacy behavior blindly. Record a contract conflict in the discrepancy ledger before
choosing new behavior. The old Django test suite is evidence, not a suite to reproduce.

`agentkit/package/` is a compatibility boundary. Do not change its vendored payload unless the task
explicitly calls for an agent-kit revision. Exercise the real Python client when changing its HTTP
contract.

## Development

Use the repository scripts rather than equivalent ad hoc commands:

```sh
bun install
bun run dev
bun run check
```

`bun run check` is the standard local gate. PostgreSQL integration and browser tests additionally
require `HOMING_TEST_DATABASE_URL`; run `bun run test:e2e` for browser journeys. Keep tests compact
and policy-oriented. Prefer one parameterized test per invariant over route-by-route duplication.

When the schema changes, update the Drizzle schema and migration together. Generated API artifacts
must remain current; `bun run api:check` verifies them.

## Security and data

- Never commit credentials, local databases, dumps, backups, tokens, or rendered environment data.
- Do not print secrets or interpolate them through diagnostic config output.
- Preserve project isolation, token project restrictions, scope checks, CSRF rules, lease safety,
  optimistic concurrency, and durable idempotency.
- Request-derived paths must resolve only through explicit allowlists.
- Treat account and project migration as transactional and idempotent. Logs may contain redacted
  counts and checksums, never imported row contents.

## Delivery

Keep commits coherent and the worktree clean. Preserve unrelated changes. Functional correctness,
security, compatibility, backup, and rollback are release gates; performance work is second-tier.
Deployment and production cutover follow the runbooks in `docs/` and require explicit human
authorization.
