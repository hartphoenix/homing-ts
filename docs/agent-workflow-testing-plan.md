# Hermetic agent-workflow testing plan

Status: core Tier A-C build implemented and adversarially complete
Date: 2026-08-22
Applies to: Homing agent kit v3 and the `homing-ts` package-serving port

Review record: plan round 1 returned 23 incomplete findings; round 2 returned 11; round 3 judged
the design complete. Post-build review then found implementation and claim-boundary defects; those
were corrected through three implementation-audit rounds, and the final review returned
`COMPLETE`. The resulting evidence is recorded in `agent-kit-lifecycle.md`. The plan
separates the implemented core gate from release-expansion cases so an unexecuted row cannot be
reported as passing.

## Outcome

Build a reusable system for testing setup prompts, installers, skills, scheduled workers, and
agent behavior without using the development agent as the target, loading the developer's agent
state, or leaving product test resources behind.

Two rules govern the design:

> The orchestrating agent is never the target agent.

> Setup is an ephemeral session; the daily worker is a separate durable product.

Containment and realism are independent. A redirected home detects many bugs but does not prevent
an untrusted process from reading absolute host paths. A Linux container contains filesystem and
process effects but does not reproduce launchd, Keychain, Windows, a desktop login session, or a
proprietary agent's hidden context. Every result names the evidence it does and does not supply.

## Product boundary to enforce

### Durable allowlist after successful setup

Only these Homing resources may remain:

- generated worker scripts and closed-schema runtime configuration;
- `prompts/JUDGE.md`, referenced directly by the scheduled runner;
- runtime state, logs, install ownership manifest, and human removal instructions;
- the scheduler definition and deliberately retained credential material;
- optional `homing-check/SKILL.md`, containing only the on-demand daily command contract.

These are setup resources and must not remain after successful setup:

- `SETUP.md`, probes, installer, finalizer, setup references, or downloaded package members;
- `homing-setup` or any other setup skill;
- connection/set-token helpers, device codes, pairing scratch, or pairing-result state;
- paths, links, imports, scheduler arguments, runtime configuration, model prompts, or discoverable
  skill text that lead back to local setup resources.

The human-only removal document may name the public setup URL. It retains no local setup guidance
or package path and is unreachable from the scheduler, daily worker, runtime prompt, and agent
discovery graph.

Connection helpers will be generated inside the verified temporary setup workspace and used while
the person is present. Reconnection, repair, and assisted removal fetch a new package. The durable
installation does not retain those helpers.

### Setup cleanup semantics

- Success: the product must verify the durable install and delete the exact setup workspace.
- Graceful stop or handled failure: the product must run `finalize.py --discard` and delete it.
- Forced termination (`SIGKILL`), agent disappearance, host crash, or power loss: no in-process
  cleanup claim is possible. Tests must detect the residue; the external container/VM teardown
  removes it. A later setup may report and reap a stale, marker-verified workspace, but this is
  recovery, not proof that the interrupted setup self-cleaned.

No persistent installer daemon, scheduled janitor, installer skill, or maintenance prompt is
created to improve the forced-termination case.

### Exact ownership and transactional mutation

The installer must stop treating a directory path as proof of ownership.

- Every install gets a random install ID.
- Every Homing-owned directory has a small ownership marker with package name, schema, install ID,
  and directory role. Shared parent directories such as `.agents/skills` are never marked or owned.
- Every owned file, link, scheduler record, and credential identifier is recorded in the install
  manifest before it is eligible for removal.
- A pre-existing unmarked `homing-check`, config, state, or scheduler target is a collision. Refuse
  it; do not overlay it.
- Repair requires matching markers and manifest relationships.
- Uninstall unlinks owned files individually, removes an owned directory only when it is empty,
  preserves foreign siblings, and returns nonzero when owned residue remains.
- Destructive actions validate canonical parent/child relationships, `lstat` type, marker identity,
  link target, link count where meaningful, and protected-root exclusions immediately before use.
- Filesystem root, home, the active setup root, the installer's current working directory,
  filesystem aliases of those exact roots, symlink boundaries, and substituted manifests are
  always refused. Shared skill roots are shared parents, not owned targets; only the marked
  `homing-check` child may be owned.

Refactor installation around a mutation journal. Register each compensation before its mutation.
On failure, undo successful scheduler commands in reverse order, restore replaced files and links,
and remove only newly created, correctly marked, empty directories. The CLI receives no test-only
environment switch. In-process Python tests inject failures through a constructor callback that
the production CLI never supplies.

This detects deterministic path/symlink substitution and prevents accidental substitution. It does not claim
resistance to a malicious process running concurrently as the same OS user and swapping path
components between validation and mutation; that actor can already modify this user's Homing
files. Native hardening may later use descriptor-relative `openat`/`dir_fd` operations with
`O_NOFOLLOW` and platform equivalents. Tests must not call repeated `lstat` checks race-proof.

## Evidence tiers

| Tier | Boundary | Containment | What a pass proves |
|---|---|---:|---|
| A | Pure contracts | Process-local | schemas, artifact bytes, generated content, ownership rules |
| B | Prevalidated temporary host child | Detection only | portable filesystem lifecycle under a filtered virtual home |
| C | Non-root Linux container | Kernel boundary | mechanical package lifecycle, mutation rollback, offline daily cycle |
| D | Target agent in disposable container/VM | Kernel/VM boundary | observable setup and daily-agent conformance |
| E | Disposable native OS VM | VM boundary | real discovery, scheduler, credential store, login/reboot behavior |

Tier B may mutate and remove exact descendants of a prevalidated temporary root. It never points a
product operation at root, the real home, repository, another host path, a native scheduler or
credential store, and never runs untrusted agent/model input. Broad escape, protected-root,
interruption, native scheduler/credential, and untrusted-agent cases begin at Tier C. A lower-tier
pass cannot satisfy a higher-tier gate.

## Generic harness architecture

Generic code must not know Homing paths, commands, manifests, or API schemas. A scenario adapter
provides those.

### Controller and write-ahead ledger

The Bun controller creates a random run ID and a direct child of the real OS temporary directory.
Before creating each resource it fsyncs a ledger entry containing its exact identifier and planned
compensation. Resource types include filesystems, child process groups, containers, images,
networks, volumes, listeners, scheduler jobs, credentials, and VM snapshots.

The controller refuses a cleanup target that is empty, broad, unresolved, a symlink boundary, or
outside the run root unless it is an exact external ID created by that run. Cleanup is safe after a
controller crash because a recovery command reads the write-ahead ledger. A TTL reaper considers
only expired resources carrying both the harness label and a valid ledger; it never scans by name
alone.

### Process containment

- POSIX children start in a new session/process group. Teardown sends `TERM`, waits a bounded
  interval, sends `KILL`, and waits for reaping.
- Container cases additionally rely on PID and mount namespaces and remove the exact container.
- Linux native cases use a cgroup or equivalent sandbox boundary when not containerized.
- Windows native cases assign every child to a kill-on-close Job Object.
- PID/name scans are diagnostic only; they are not cleanup mechanisms.

All child processes are stopped before setup-package deletion. Daily-agent tests start a new,
non-resumed child only after setup cleanup.

### Three-stage residue accounting

1. Product audit, before harness cleanup: record owned resources, setup residue, foreign-resource
   damage, running descendants, leaked values, and product cleanup status.
2. Exact harness cleanup: apply only ledgered compensations in reverse order.
3. Boundary audit: prove no run resource escaped or survived containment, and that host guards are
   unchanged.

Harness cleanup never rewrites the product cleanup result. VM/container destruction is reported as
containment cleanup, not product self-cleanup. A second cleanup pass must be a no-op.

### Snapshot and canary semantics

Compare path, type, mode, ownership where available, size, mtime, link target, and content digest.
Exclude atime and ctime. Repository checks compare tracked content plus declared generated paths,
not unrelated untracked work owned by another agent.

CI uses synthetic host roots. Local personal roots are never read by default. If the developer
explicitly enables personal guard roots, the harness hashes bytes without printing them and
disables parallel mutation tests. Unique host and target canaries prove both directions: target
output must not contain a host canary, and host guards must not contain a target canary. Fixture
secrets and environment canaries are scanned in outputs, transcripts, logs, and results.

### Generic module layout

- `tests/agent-harness/controller.ts` — run lifecycle and result aggregation;
- `tests/agent-harness/ledger.ts` — durable write-ahead resource ledger and exact recovery;
- `tests/agent-harness/process.ts` — process groups, deadlines, signals, and capture bounds;
- `tests/agent-harness/environment.ts` — platform/persona allowlists and secret rejection;
- `tests/agent-harness/persona.ts` — identity, tools, locale, timezone, filesystem, and calibration;
- `tests/agent-harness/audit.ts` — snapshots, canaries, leak scan, and three-stage residue audit;
- `tests/agent-harness/container.ts` — generated build context and container lifecycle;
- `tests/agent-harness/result.ts` — result schema and evidence claims.

## Environment fidelity

### Virtual filesystem

```text
<os-temp>/homing-agent-test-<run-id>/
  home/
    Downloads/Homing setup – O'Neil/     quoting fixture, not package root
    .agents/skills/
  codex-home/
  xdg/config/
  xdg/state/
  xdg/cache/
  tmp/
    homing-agent-kit-<package-id>/        verified removable setup package
  input/                                  exact controller-generated inputs
  tool-bin/                               strict adapters only
  transcripts/
  ledger.json
```

`finalize.py` requires the verified package to be a direct child of the persona's temporary
directory named `homing-agent-kit-*`; tests follow that contract. The path with spaces,
apostrophe, and Unicode is used for input/output quoting cases that do not violate the finalizer
guard.

### Platform-specific environment

Do not copy the developer's environment, and do not use an unrealistically empty environment.
Each persona declares and calibrates its own allowlist.

- POSIX: isolated `HOME`, `USER`, `LOGNAME`, `TMPDIR`, XDG roots, agent roots, supported locale,
  timezone, shell, and normal system `PATH` plus the isolated adapter directory.
- macOS: use a locale returned by `locale -a`; preserve only documented launch-services/system
  variables needed by the tested command; use system CA discovery, not host certificate override
  variables.
- Windows: additionally provide calibrated `SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP`, `TMP`,
  `LOCALAPPDATA`, `APPDATA`, and required system paths.
- Codex: create `CODEX_HOME` and `HOME/.agents/skills` before launch. Repository discovery is tested
  separately; daily tests run from a non-repository directory.

Reject inherited variable names containing token, key, password, credential, cookie, session,
authorization, cloud-account, registry-auth, or SSH-agent semantics. Host proxy and CA override
variables are not inherited. A fixture proxy or CA is an explicit declared input and is labeled as
fixture transport evidence.

Before product execution, calibrate file creation, executable lookup, the documented Python floor,
shell behavior, UTF-8, timezone, temp semantics, localhost, process termination, and the exact tool
inventory. When networking is enabled, separately calibrate system CA trust and fixture-CA trust.
Calibration failure is `HARNESS_ERROR`; no product pass/fail is emitted.

### Nontechnical-user personas

1. `first-time-user`: supported agent installed; no Git, Bun, Node, compilers, global Homing files,
   or custom dotfiles; Python absent or older than 3.9. The shell probe must report the condition
   correctly and mutate nothing. Only target-agent conformance may claim that the explanation is
   understandable.
2. `equipped-user-py39`: non-root ordinary account with exactly the latest available Python 3.9
   patch release, POSIX shell, CA roots, curl, and core OS tools. This owns the documented floor.
3. `equipped-user-current`: the same persona on the current supported Python release. Every result
   records the exact interpreter build and architecture.
4. `existing-user`: unrelated skills/configuration and foreign sibling files, plus variants with a
   valid prior Homing install, valid legacy setup residue, lookalike foreign residue, denied roots,
   and symlinked roots.

Container personas model Linux filesystem/process behavior only. Native VM personas own real
scheduler, store, and agent-discovery claims.

## Homing scenario adapter

Add `tests/agentkit/scenario/` with:

- artifact materialization from `buildAgentKitArtifact`, including manifest and archive;
- persona install-plan construction;
- durable-resource allowlist and forbidden setup markers;
- lifecycle commands and expected exit classes;
- strict scheduler/model adapters and transcript schemas;
- fake Homing/source service and its closed state machine;
- package, daily-cycle, ownership, migration, and cleanup assertions.

`tests/agentkit/virtual-user/run.py` is the deterministic Tier C scenario driver. It performs the
setup prompt's mechanical lifecycle as an explicit harness action and records every driver action as
`simulated-orchestrator` provenance. It does not prove that a target agent followed the prompt.
Only Tier D may label finalize/discard as target-agent compliance.

The container receives a controller-generated build context containing only a pinned Dockerfile,
the byte-exact public artifact, scenario runner, fixture CA/certificate, and closed-schema inputs.
It never receives the repository.

### Strict command adapters

Adapters accept only versioned command shapes derived from cited primary OS command documentation
and the product's generated schemas. Tier E later compares those fixtures with native transcripts;
until that comparison exists, results say `document-derived`, not `observed`. Every invocation writes
bounded JSON Lines containing adapter version, argv, cwd, selected non-sensitive environment names,
monotonic sequence, configured response, and exit code. Unknown shapes fail. Adapters are contract
fixtures, never evidence that launchd/systemd/Task Scheduler or a real key store behaves that way.

The fake model CLI:

- records a digest and bounded structural description of stdin, argv, cwd, and allowed environment;
- requires stdin to equal the installed `JUDGE.md` byte for byte;
- requires `prompt.txt` and `candidates.jsonl` in the isolated work directory and refuses setup
  markers/canaries anywhere in its accessible inputs;
- emits deterministic, closed-schema `scored.jsonl` data;
- rejects extra arguments, setup paths, inherited credential variables, and undeclared files.

### Fake HTTPS services

Use one isolated stateful fixture service with a generated test CA, certificate for
`homing.test`, and explicit hostname mapping inside containment. The target trusts only the system
roots plus that fixture CA. A pre-product HTTPS calibration request must pass. HTTP loopback may be
used for unit tests but is labeled transport-bypassed and cannot satisfy TLS evidence.

The target image/build context receives only the fixture root certificate. The CA signing key and
server private key remain inside the ledgered fixture-service boundary and never enter the target
image, transcript, or exported result.

The service exposes only the routes required by one cycle:

- `GET /api/v1/me/projects`;
- `GET /api/v1/projects/{id}` and prompt/change-feed reads used by the installed client;
- source-plan review report/read responses;
- `GET /robots.txt` and one allowlisted source document;
- search-run create/list, claim, heartbeat, completion;
- lead bulk-upsert and verification reads.

Its state machine is `ready -> project-read -> source-read -> run-created -> claimed ->
leads-written -> completed`. Duplicate idempotency keys replay the first result; out-of-order calls,
unknown routes, undeclared hosts, excessive calls, and destructive lead endpoints fail. Named
scenarios return 401, 403, 409, 410, 429, malformed JSON, timeout, and connection loss. Transcripts
record method, normalized route, body schema/digest, authorization presence only, idempotency key
digest, state transition, and response—never credential values or free-text page bodies.

This proves daily mechanics and the prompt input boundary exposed to the fake model. It does not
prove a proprietary agent's invisible internal context. For a real agent the defensible oracle is:
setup bytes are absent from documented discovery roots and durable files, the setup session is not
resumed, the package is gone, and observable file/tool traces contain no setup access. Stronger
claims require a product-provided context or file-access trace.

## Agent adapters and support matrix

The core kit stays agent-agnostic. Product-specific discovery, invocation, authentication, and
transcript logic lives in adapters. A product is not “supported” merely because it can read
Markdown.

| Agent | Pinned initial conformance version | Status | Discovery evidence |
|---|---:|---|---|
| Codex CLI | 0.149.0 | planned adapter target; no conformance claim | `CODEX_HOME`; user and repository `.agents/skills` from official OpenAI docs |
| Claude Code | 2.1.234 | planned adapter target; no conformance claim | canonical plus Claude-specific skill root |
| Gemini CLI | 0.38.2 | portability probe only, not supported yet | no discovery claim until primary docs and native scenario exist |

Every implemented adapter records actual version and fails closed outside its declared compatible
range until reviewed. All rows remain agent-neutral integration designs, not supported-host claims,
until a pinned Tier D adapter passes. The matrix is a versioned fixture updated intentionally.

## Test suites

### Tier A — required on every change

- TypeScript manifest/member/archive/route/cache/method contracts;
- setup prompt is explicitly fetched and never discoverable as `SKILL.md`;
- daily worker pins durable `JUDGE.md`; optional daily skill contains no setup content;
- scheduler-only installation produces no skill;
- setup-marker graph scan from every daily entry point;
- ownership marker, manifest relationship, collision, and protected-root validation;
- parameterized quoting/metacharacter/path cases;
- secret-shaped input refused before mutation;
- transactional journal unit tests with injected failure at every mutation callback;
- legacy migration policy over valid residue, foreign lookalikes, non-Claude roots, denied roots,
  and symlinked roots; only verified Homing-owned legacy residue is removable.
- render and parse scheduler artifacts/command contracts for macOS, Linux, and Windows without
  claiming host behavior.

### Tier B — detection-only host checks

- artifact generation and structural verification;
- installer/self-test/runner `--help` and install `--dry-run` using only prevalidated paths under the
  virtual root;
- no scheduler, credential operation, target agent, untrusted prompt, destructive uninstall,
  tampered manifest, or forced interruption.

### Tier C — required contained lifecycle

For `install_skill=false` and `true`:

1. Materialize package A from the exact TypeScript artifact into the persona temp directory.
2. Verify/init A, install with a fixture credential channel, run self-test, and assert the durable
   allowlist.
3. Finalize A and prove its setup workspace disappeared and the target UID cannot read the
   supervisor's root-owned artifact source.
4. Start clean, non-resumed daily processes and run two cycles against the strict model and fake
   HTTPS services, proving independence from the deleted package and setup process.
6. Materialize fresh package B; verify/init it, run repair dry and real while preserving scheduler
   state, run self-test, then finalize B.
7. Start another clean daily process and verify daily behavior after repair.
8. Uninstall with log purge; assert foreign siblings remain and owned residue does not.
9. Perform the three-stage audit and a second no-op cleanup.

The core gate repeats the lifecycle for scheduler-only and optional-skill existing-user cases. It
also runs the complete install/repair mutation-checkpoint suite, verified legacy/lookalike cases,
unowned collisions, canonical-manifest substitution, symlink/hard-link substitution, protected
roots, a missing-runtime first-time persona, and harness self-tests. The additional protocol,
signal, and native-scheduler cases below are release-expansion work and remain explicit gaps until
implemented at their stated tier.

Tier C executes scheduler `none`; the controller's explicit invocations prove daily-process
separation without pretending to be an OS scheduler. Document-derived scheduler renderers and argv
contracts remain Tier A fixtures. Real launchd, systemd user-session, and Task Scheduler behavior
belongs exclusively to Tier E.

### Tier D — setup-agent and daily-agent conformance

This is distinct from directly invoking installer scripts. A fresh target-agent process receives
only the public `/agent/` entry prompt and fixture tools. Before installation, the adapter records
the product's bundled/system/user/repository skill inventory so assertions compare the Homing delta
rather than expecting an empty agent.

A closed-schema interaction driver owns the human side of the conversation. It reads the fixture
service's public approval code, asserts that the target agent displays the matching code and URL,
advances fixture approval/deny/expiry state, runs the explicitly human-owned helper action in a
separate recorded process, and supplies only scenario-declared answers to gated questions. Each
message is tagged `target-agent`, `simulated-human`, `fixture-service`, or `harness`; the result does
not attribute harness actions to the agent. Continuations use the adapter's documented fresh-turn
mechanism, while the post-setup daily check always starts a new non-resumed session.

Observable oracles cover:

- fetch ladder, manifest verification, and temp-root placement;
- one probe run and correct tri-state interpretation;
- progressive reference reads and no unrelated reference preload where file traces are exposed;
- zero questions in the fully determined persona and bounded plain-language questions in gated
  personas;
- no Homing credential value in observable Homing channels, transcripts, or model inputs;
- generated plan matches the closed schema and observed probe evidence;
- handled stop uses discard; success finalizes;
- the setup process is terminated before a new daily process starts;
- the daily process sees only the optional `homing-check` delta and invokes the durable worker;
- scheduler-only setup exposes no Homing skill.

Agent output wording is evaluated by bounded semantic predicates and required facts, not an exact
sentence. The artifact/transcript oracles remain deterministic.

### Tier E — native release matrix

On clean macOS, Linux desktop, and Windows VMs, test register, run-once, login/logout or reboot,
pause, resume, repair without scheduler-state change, credential non-disclosure, uninstall, and
verified snapshot reversion. Each agent/OS/store combination reports pass, fail, or skip separately.

VMs have no shared home, folders, clipboard, keychain, SSH agent, Docker socket, bridged LAN, or
personal authentication. Artifact transfer uses a one-way controlled channel. Egress is restricted
to staging Homing, declared source fixtures, agent-provider endpoints when required, and OS time/CA
services. Start from a named snapshot; after tests, compare external resource inventory, revert,
boot, and verify the baseline again.

## Failure matrix

The matrix is a roadmap, not a single pass bit. The `Core gate` column defines the current Tier A-C
completion contract. `Expansion` rows must be reported as unexecuted and may not contribute to a
passing core result. They become blocking only when the corresponding Tier D/E release target is
enabled or a future change promotes the row into the core gate.

Every implemented row is parameterized over both fresh install and repair when applicable.
Expected product residue is measured before containment teardown.

| Gate | Stage/injection | Mechanism | Expected product result |
|---|---|---|---|
| Core | download member/archive | replace, omit, duplicate, path escape | verification refusal; no init or durable write |
| Core | manifest/init | malformed fields, symlink/hard-link member, wrong temp parent, marker substitution | refusal; no durable write |
| Core | probe | missing runtime | exact tri-state; no product state |
| Core | directory creation `[n]` | injected failure before/after every mutation checkpoint | rollback owned new dirs; preserve pre-existing dirs |
| Core | generated file replacement `[n]` | injected failure before/after every mutation checkpoint | fresh install empty; repair byte-identical to prior install |
| Core | skill link/copy `[n]` | collision and symlink/hard-link substitution plus checkpoint injection | no foreign overwrite; rollback owned entry |
| Core | scheduler command `[n]` | strict shim plus failure before/after every checkpoint | inverse operations for completed steps; no active new job |
| Core | finalize | missing/tampered durable manifest | refusal; durable install unchanged |
| Core | repair | every mutation checkpoint | old install restored byte-for-byte |
| Core | uninstall | foreign sibling, manifest tamper, symlink/hard-link substitution | only verified owned entries removed; nonzero on residue |
| Core | harness integrity | planted leaks, false calibration, descendant, cleanup escape, residue | harness refuses or reports each fault |
| Expansion | probe | old tools, denied path, proxy-required network, TLS failure, TERM | exact tri-state/error; no retained probe file |
| Expansion | pairing/helper | deny, expire twice, malformed response, TERM | no key disclosure; graceful discard removes helper |
| Expansion | self-test | forced failure | install remains explicitly incomplete; handled stop discards package |
| Expansion | first daily run | timeout, 401/403/409/410/429, malformed data, TERM | bounded exit/state; no setup access; lock/work cleanup |
| Expansion | finalize | deletion denial | detected setup residue; durable install unchanged |
| Expansion | controller TERM | signal at each lifecycle boundary | ledger recovery and exact containment cleanup |
| Expansion | explicit graceful cancel | supported workflow cancel/stop action | discard required; no setup residue |
| Expansion | target TERM | process-group termination at each child | handler cleanup or explicitly detected residue |
| Expansion | target KILL/host crash | uncatchable termination | residue detected; cleanup labeled external |

Machine-readable results use this exact expansion-row set:
`probe_environment_errors`, `pairing_helper_errors`, `selftest_failure`,
`daily_protocol_errors`, `finalize_deletion_denial`, `controller_term`, `graceful_cancel`,
`target_term`, and `target_kill_or_host_crash`. Each is `UNEXECUTED` until its row is implemented.

Contained destructive tests exercise `/`, home, symlink swaps, hard links, manifest substitution,
and foreign ownership. Unit contracts additionally enforce setup-root/current-directory and
realpath-alias refusal. Shared roots are preserved parents around an exact owned child. The
destructive cases execute inside containment so a product validation bug cannot damage the host.

## Container contract

- pinned minimal Linux base by registry digest; record architecture and resolved digest;
- generated allowlisted build context, never repository `.`;
- empty disposable Docker client config; no host proxy, build secret, credential helper, or registry
  config inherited;
- read-only root filesystem, private tmpfs home/temp/state, bounded memory/PIDs/CPU/files, and no
  host namespaces; the trusted PID 1 harness keeps only `CHOWN`, `DAC_OVERRIDE`, `SETUID`, and
  `SETGID` long enough to materialize each setup package and demote product processes to the
  ordinary target UID; target setup and daily processes retain no capabilities;
- no Docker socket, host home, repository, global cache, SSH agent, browser profile, or personal
  agent root;
- no bind mounts at target runtime; artifact is copied into the generated image/context;
- LAN/outbound disabled for lifecycle tests; a dedicated private fixture network only for fake
  HTTPS service tests, with no default route beyond fixture containers;
- exact run-labeled container/network/volume/image IDs ledgered before creation and removed after;
- `--rm` where compatible, plus explicit recovery for abnormal controller death.

Shared base-image and BuildKit caches are accepted Docker-engine caches, not Homing installation
state. Results report that fact. Derived run images, containers, networks, and volumes are not
retained. CI must fail if Docker is unavailable; local execution reports an unmet Tier C claim,
never a pass.

## Result schema

Each command writes bounded JSON containing:

- schema/harness/scenario version, git commit, and dirty-state boolean;
- tier, persona, OS, architecture, agent adapter and actual/pinned version;
- containment mechanism, base-image digest, network mode, fixture-CA digest;
- effective locale/timezone/tool inventory and names of allowed environment variables;
- calibration, product, product-residue, harness-cleanup, and boundary-audit statuses;
- each evidence claim and its source tier;
- skips with the exact unmet claim and missing resource;
- transcript/artifact digests, duration, and run ID;
- cleanup provenance: product, harness compensation, container destruction, or VM reversion.

No result contains raw prompts, fetched pages, credentials, inherited values, or personal paths.
`--keep` is an explicit local debugging mode, marks cleanup skipped, prints the exact run root, and
is forbidden in CI.

## Repository implementation

Add the generic harness and Homing adapter described above, plus:

- `tests/agent-harness/harness.test.ts`, `tests/agentkit/failure-matrix.test.ts`, and
  `tests/server/agentkit-lifecycle.test.ts` — Tier A/B contracts and lifecycle assertions;
- `tests/agentkit/virtual-user/Dockerfile` and minimal target runner;
- `scripts/test-agentkit-container.ts` — generated context, container run, result import, cleanup;
- `scripts/test-agentkit-external.ts` — guarded Tier D/E entry point;
- `tests/agentkit/native/README.md` and result fixtures for Tier E;
- `docs/agent-workflow-testing.md` — reusable operating guide distilled from this build plan.

Modify the product to:

- move connection helpers and pairing scratch into the temporary setup workspace;
- add install IDs, ownership markers, strict destructive validation, and exact uninstall;
- replace best-effort rollback with the mutation journal and scheduler compensations;
- make legacy setup cleanup deterministic and agent-neutral;
- retain only the durable allowlist after successful setup.

Update `package.json` with:

```text
test:agentkit             Tier A and safe Tier B
test:agentkit:container   required Tier C
test:agentkit:live        guarded Tier D; requires --allow-live-agent
test:agentkit:host        guarded Tier E; requires --allow-native-host
```

CI runs Tier A/B in the application job and Tier C in the existing Docker-capable job. It treats
container absence, retained derived resources, calibration failure, product residue, harness
cleanup failure, or boundary-audit failure as blocking.

## Execution order

1. Preserve the existing passing baseline in the dedicated `feat/agentkit-v3` worktree.
2. Implement generic guard/ledger/process/audit primitives and prove planted escape, leak,
   descendant, and residue detection.
3. Add product ownership markers, protected-root validation, exact uninstall, and mutation journal.
4. Move pairing helpers into the setup workspace and enforce the durable allowlist.
5. Move existing lifecycle tests onto the Homing scenario adapter; add the core failure gate and
   preserve the remaining matrix as explicitly unexecuted expansion work.
6. Add and calibrate the fake model and fake HTTPS state machine; run one complete daily cycle.
7. Add the non-root container persona and cleanup recovery.
8. Add commands and blocking CI tiers.
9. Run Tier A/B twice, in parallel and serial forms; run Tier C when a container engine is
   available; run the complete repository check.
10. Record actual evidence and explicit Tier D/E gaps in `docs/agent-kit-lifecycle.md`.

## Completion criteria

The implementation is complete when:

- planted harness escape, leak, residue, descendant, and false-calibration cases are detected;
- every core failure-gate row passes, including every install and repair mutation checkpoint;
- expansion rows are individually reported as unexecuted and never summarized as passes;
- the product audit shows exactly the durable allowlist after setup and zero owned resources after
  uninstall while preserving all foreign fixtures;
- setup/daily processes are distinct; no setup package member, helper, local setup prompt/reference,
  setup skill, or setup edge is reachable from scheduler/daily entry points or documented agent
  discovery roots;
- the complete fake-service daily cycle proves the observable prompt boundary and expected writes;
- Tier A/B pass twice, serially and in parallel;
- Tier C passes in CI and any available local engine, with exact resource cleanup;
- current application typecheck, lint, unit/integration tests, build, and Python compilation pass;
- live/native gaps remain explicit rather than being promoted from shim evidence;
- this plan passes both primary and adversarial review as complete.

## External release resources

Tier D/E execution requires disposable OS images, test-only agent/provider credentials, and a
staging Homing account. Their absence does not block building Tiers A-C, but it blocks the specific
supported-agent/native release claims identified in the result matrix.
