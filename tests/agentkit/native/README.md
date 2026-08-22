# Native and live-agent release tests

Tier D and E are release tests, not local-development tests. They remain `SKIP` until a disposable
agent account, a staging Homing account, and clean named VM snapshots are provisioned.

Never run them against a developer home. Each VM must have no shared home, clipboard, keychain,
SSH agent, Docker socket, browser profile, or personal agent configuration. Transfer the exact
tested artifact through a one-way channel, restrict egress to the declared test endpoints, record
the initial resource inventory, and revert the named snapshot after the product residue audit.

The commands require explicit authority and currently stop after the guard because no external
adapter or disposable credentials ship in this repository:

```text
bun run test:agentkit:live -- --allow-live-agent
bun run test:agentkit:host -- --allow-native-host
```

Implement one version-pinned adapter per supported agent. A release result must identify the agent
and version, OS image and snapshot, credential source class (never value), network allowlist,
artifact digest, setup-session transcript digest, fresh daily-session transcript digest, product
residue audit, external-resource audit, and verified snapshot reversion. A shim or fake model is
Tier C evidence and must not be reported as real-agent support.
