# Homing TypeScript

Greenfield TypeScript replacement for the Django Homing application. Humans use the React
interface; recurring search agents use the versioned `/api/v1` contract. The public setup package
and generated worker templates live under `agentkit/package/`.

The Django repository at `../homing` remains the behavioral reference and rollback source during
the replacement sprint.

## Development

```sh
bun install
bun run db:migrate
bun run dev
```

Run `bun run dev:client` separately for Vite hot reload. Production serves the built client and API
from one Bun process behind Caddy.

## Verification

```sh
bun run typecheck
bun run lint
bun run test
bun run build
bun run test:e2e
```
