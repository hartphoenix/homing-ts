# Hermetic testing for agent workflows

Agent workflows need two kinds of isolation at once: process isolation for the software and
context isolation for the agent. A temporary `HOME` alone provides neither. The reliable pattern
is a layered harness with explicit evidence boundaries.

## The standard pattern

Use three mutually distrustful components:

1. A host controller creates disposable resources, records them before creation, starts the test,
   imports a bounded result, audits residue, and removes only resources bearing that run's ID.
2. A target environment represents the end user. It receives an allowlisted environment, exact
   product artifact, blank agent/config roots, ordinary permissions, and no host mounts or
   credentials.
3. Fixture services supply deterministic model and network behavior. They receive fixture data
   only and cannot reach production.

For Linux and portable filesystem behavior, use a non-root container with a read-only root and a
tmpfs home. For macOS Keychain, LaunchAgents, Windows DPAPI and Task Scheduler, login/session
behavior, GUI approval, or a real agent host, use a clean VM snapshot. Containers cannot establish
those native claims. Run real-agent tests with disposable provider and application accounts; a
fake model is not evidence that an agent followed a setup prompt.

When a contained lifecycle must supply multiple fresh setup packages, use a trusted supervisor
outside the target identity. Keep the artifact in a root-only image path, materialize one
user-owned temporary copy for each setup phase, run the product as the ordinary UID, and remove
that copy before starting a fresh daily child. The supervisor may retain only the capabilities
needed to copy and demote; every product and model child must have none. This preserves a clean
daily filesystem boundary without a host mount or a setup artifact readable by the target.

Never run destructive installer, scheduler, credential-store, or uninstall cases in a developer's
actual home. A second Unix account is useful for manual exploration but is weaker than a VM because
it still shares the kernel, services, network, and often privileged host resources.

## Evidence tiers

| Tier | Environment | Establishes |
|---|---|---|
| A | Pure unit tests | Parsing, quoting, validation, deterministic transforms |
| B | Temporary virtual home and subprocesses | Portable filesystem lifecycle, environment boundary, rollback |
| C | Locked-down container plus fake HTTPS/model | Non-root Linux lifecycle, closed network, fresh daily process |
| D | Disposable real-agent account in containment | Agent discovery, prompting, tool use, setup-to-daily separation |
| E | Clean native VM snapshots | Real schedulers, stores, login/reboot behavior, native uninstall |

Report pass, fail, or skip per claim. Do not promote a Tier C result into agent or native-platform
support. Local container absence is a skip with an unmet claim; CI container absence is a failure.

## Target persona

A representative nontechnical persona has:

- an ordinary non-root account and default shell behavior;
- an empty agent root, empty application config/state/cache, and no developer dotfiles;
- a realistic `Downloads` path, including spaces, Unicode, and an apostrophe;
- the documented minimum runtime and the current runtime as separate cases;
- standard locale, timezone, umask, filesystem permissions, and PATH;
- no compiler, package manager, repository checkout, Docker socket, SSH agent, cloud CLI, personal
  browser profile, or ambient application credential unless the product explicitly requires it.

Calibrate before testing: prove home expansion, temp resolution, Unicode I/O, runtime version,
architecture, locale, and timezone. A failed calibration invalidates the environment. It is not a
product failure.

Build the target environment from an allowlist. Never clone the controller's environment and then
remove familiar key names; unknown credentials and proxy or CA overrides will eventually leak.
Pass fixture trust roots explicitly, record the allowed variable names, and scan transcripts for
sentinel values rather than persisting raw host values.

## Artifact and network boundaries

Test the exact release artifact: build its manifest and archive through the production package
builder, verify it, and copy it into the target image. Generate a Docker build context containing
only the target Dockerfile, scenario runner, fixture CA, and that artifact. Never use the repository
root as the build context for an installer test.

Archive validation must precede extraction. Use a bounded bootstrap fetched from the same trusted
origin: authenticate the complete archive bytes, reject absolute/parent/duplicate/non-regular and
undeclared members, then write beneath one prevalidated temporary root. Hashing files after a
generic unzip is too late to prevent an extraction escape.

Use an empty disposable Docker client config. Do not inherit `DOCKER_HOST`, proxy settings,
credential helpers, registry auth, SSH forwarding, BuildKit secrets, or personal CA settings.
Pin each base image by architecture-specific registry digest and record the selected digest.

Lifecycle tests use an internal container network with only named fixture services. The target has
no host network, published ports, default external route, host bind mount, Docker socket, or shared
cache. TLS remains enabled: generate a per-run CA, put only the CA certificate in the target, and
keep the fixture private key in the fixture build context.

## Installer design required for testability

Separate setup from daily operation structurally:

- Setup is an explicitly fetched prompt and verified temporary package.
- Connection helpers, fallback credential helpers, probes, device codes, and setup result files
  remain inside that package.
- Success finalizes the package; a handled stop discards it. Repair fetches a new package.
- The scheduler points directly to a durable worker prompt and runner.
- The optional daily skill is a thin facade over that runner. A scheduler-only install writes no
  skill.
- The durable manifest contains no setup file, path, prompt, helper, or edge.

An install owns exact files, not broad directories. Give it a random install ID and put a marker in
each product-owned directory. Before writing, reject protected roots, existing unowned targets,
symlinked path components, mismatched markers, and broad or repeated manifest paths. Uninstall
validates those records, removes exact regular files and known runtime scratch, refuses symlink and
hard-link substitutions, and preserves foreign siblings.

Make install and repair transactional. Before any mutation, journal the inverse operation. Stage
same-directory file backups, preserve prior links, record newly created directories, and retain
scheduler compensation commands. Test-only in-process callbacks should exist immediately before
and after every directory, link, file replacement, permission transition, and scheduler step.
Fresh-install failure must leave no product residue; repair failure must leave the prior install
byte- and mode-identical.

## Harness integrity

The harness needs adversarial tests of its own. Plant and verify detection of:

- a path escape and a symlink cleanup boundary;
- a host sentinel copied into target output;
- a target sentinel written into a synthetic host guard;
- an inherited credential, proxy, or CA variable;
- a descendant process that ignores TERM;
- product residue hidden by containment teardown;
- harness residue and a false calibration result.

Use a write-ahead resource ledger. Record each directory, process group, container, network, image,
and volume before creating it; fsync the record; then mark it created and cleaned. Filesystem cleanup
must remain under a verified run root and refuse symlinks. Container resources carry both a harness
label and unique run label. Audit only the current run label so concurrent runs cannot cause false
positives. Recover an interrupted run only from a valid controller record; derive resource names
from its validated run ID rather than trusting arbitrary stored cleanup paths.

Distinguish cleanup provenance:

- `product`: the application removed its own resources;
- `harness compensation`: the controller reversed a partially created fixture;
- `container destruction`: containment removed otherwise surviving state;
- `VM reversion`: the native snapshot was restored.

Audit product residue before destroying containment. A clean host after container removal does not
prove uninstall or setup finalization worked.

## Homing commands

```text
bun run test:agentkit
bun run test:agentkit:container
bun run test:agentkit:live
bun run test:agentkit:host
```

For a disposable local engine whose socket is not `/var/run/docker.sock`, pass one explicit,
absolute Unix socket without changing the developer's Docker context:

```text
bun scripts/test-agentkit-container.ts --docker-host=unix:///absolute/path/to/docker.sock
```

`test:agentkit` runs Tiers A and B. `test:agentkit:container` is required in CI and reports a local
skip when the isolated default container engine is absent. Live and native commands are guarded and
remain explicit skips until disposable accounts, adapters, and VM snapshots are provisioned.

The detailed implementation and completion contract are in
[`agent-workflow-testing-plan.md`](agent-workflow-testing-plan.md). Product-specific evidence is in
[`agent-kit-lifecycle.md`](agent-kit-lifecycle.md).
