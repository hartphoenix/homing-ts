# Homing TypeScript

TypeScript Homing application. Humans use the React interface; recurring v2 search agents use the
versioned `/api/v1` contract. The reviewed Python v2 agent-kit payload is vendored under
`agentkit/package/` and published from this repository.

The Django repository at `../homing` is behavioral evidence only. It is not a production deployment
or rollback target.

## Development

```sh
bun install
bun run dev:setup
bun run dev
```

Run `bun run dev:client` separately for Vite hot reload. Production serves the built client and API
from one Bun process behind Caddy. Local development uses a disposable Docker PostgreSQL service
bound only to `127.0.0.1:5432`; `bun run dev:setup` starts it and applies migrations.

To use the private Docker rehearsal API while developing the client:

```sh
HOMING_DEV_PROXY_TARGET=http://127.0.0.1:8081 bun run dev:client
```

## Verification

```sh
bun run typecheck
bun run lint
bun run test
bun run build
bun run test:e2e
```

The public agent lifecycle is documented in [the v2 build specification](docs/build-spec.md),
[the lifecycle plan](docs/agent-kit-lifecycle-plan.md), and the generated [API contract](docs/openapi.json).
