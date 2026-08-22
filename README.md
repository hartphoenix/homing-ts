# Homing TypeScript

Greenfield TypeScript replacement for the Django Homing application. Humans use the React
interface; recurring search agents use the versioned `/api/v1` contract. The Python agent-kit
payload is vendored unchanged under `agentkit/package/`.

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
