# Agent-kit lifecycle and TypeScript port plan

Date: 2026-08-21

## Decision

Treat the public entry document as an ephemeral **setup prompt**, not an installed skill.
`homing-check` remains the only durable Agent Skill, because it is the small interactive command
surface a person may use after setup. The scheduled worker is not a skill: it is generated scripts,
configuration, state, and a scheduler entry outside every skill root.

The kit remains agent-agnostic. Host-specific adapters may locate skill directories, constrain
tools, or register schedulers, but lifecycle correctness must not depend on a Claude-, Codex-, or
Gemini-specific metadata field.

## Target architecture

```text
Homing setup page
  -> temporary setup package
     -> probe, pair, discover sources, install, verify
     -> delete temporary setup package

Durable installation
  -> worker: run script, API/source clients, config, state, logs, scheduler
  -> scoring prompt: read-only runtime file outside all skill roots
  -> optional homing-check skill: thin interactive facade that invokes the worker

Later repair, upgrade, or assisted removal
  -> fetch a fresh temporary setup package
  -> operate on the durable install manifest
  -> verify and delete the fresh package again
```

## Lifecycle invariants

1. No setup document, setup reference, probe, installer, self-test, or package archive persists in
   a user, repository, admin, or system skill root.
2. No scheduled entry point can reach setup material, directly or transitively.
3. The installed manifest records only durable worker artifacts and the optional `homing-check`
   facade.
4. `homing-check` contains no setup, discovery, repair, scheduler, credential-store, or environment
   selection guidance.
5. Repair and upgrade always begin from a fresh package served by Homing. The worker never upgrades
   or rewrites itself.
6. A successful setup includes successful cleanup. Cleanup failure is reported accurately as
   "installed, but temporary setup files remain," not as complete success.
7. Claims about model context describe the full harness behavior that was verified, not merely the
   bytes sent on stdin.

## Work plan

### 1. Lock the present behavior with lifecycle tests

Make the current Django repository the production package source until the TypeScript cutover.
Add failing tests there before changing the package, then vendor the resulting package into this
repository without hand-editing the second copy.

Add tests proving:

- the scheduler invokes only the generated worker;
- the worker's transitive file graph contains no setup-package path or marker;
- any legacy `homing-setup` installation under any known skill root is a failure, not a note;
- a fresh package can repair and uninstall an installation after the original package is gone;
- the no-shell path writes no package files and therefore needs no cleanup;
- partial installation rollback and temporary-package cleanup are independent and idempotent.

### 2. Replace the installer skill with a setup prompt

- Rename the canonical package entry from `SKILL.md` to `SETUP.md`.
- Remove Agent Skill frontmatter and all claims that the setup procedure is installed or
  discoverable.
- Rename `homing-setup` in user-facing and internal prose to `Homing setup prompt` or `setup
  procedure`.
- Change `/agent/`, the copied setup instruction, the archive manifest, and package verification to
  name `SETUP.md`.
- Keep legacy `/agent/pkg/SKILL.md` and `/agent-setup/SKILL.md` as same-origin HTTP redirects to
  `SETUP.md` for one compatibility window. Do not include a legacy `SKILL.md` file in the archive.
- Bump the package version. Do not mutate already-installed workers merely because the public
  package changed.

Acceptance: saving the package beneath `.agents/skills`, `.claude/skills`, or another skill root
does not make the setup procedure discoverable because the package contains no `SKILL.md`.

### 3. Make setup-package cleanup explicit and safe

- Require byte-exact downloads to use a newly created temporary directory and record that exact
  path as the setup workspace.
- Add a small standard-library finalizer invoked only after installation, self-test, and the first
  real check succeed.
- Have the finalizer refuse broad paths, home directories, repository roots, skill roots, synced
  folders, and directories without the package marker and verified manifest.
- Delete only manifest-listed package files, the downloaded archive, the marker, and now-empty
  package directories. Refuse unexpected files rather than deleting them.
- Run the same bounded cleanup after a verification failure when no durable install was changed.
- Make cleanup idempotent and cover POSIX and Windows behavior in tests.

Do not preserve `install.py` merely to support later maintenance. A later repair or assisted
removal fetches a current setup package. Update the installed `UNINSTALL.md` and final report so
they do not present the deleted `install.py` as a locally available command; retain direct native
pause/removal instructions and the Homing-side disconnect path.

### 4. Separate the worker from the interactive skill physically

- Move `JUDGE.md` from `homing-check/` to a read-only runtime prompt directory under the durable
  config root.
- Keep `homing-check/SKILL.md` as a minimal facade: invoke the generated worker, read bounded result
  state, and report it.
- Install `homing-check` only when the environment has a compatible interactive agent. A scheduler-
  only installation does not need a discoverable skill.
- Use one portable invocation policy for the skill. Host-specific tool restrictions may differ,
  but a Claude-only invocation policy must not silently change the product behavior.
- Preserve natural-language invocation as the default: one legitimate daily skill description is
  acceptable; setup guidance is not.

Acceptance: the skill directory contains only interactive-use material, while deleting the skill
leaves scheduled operation intact.

### 5. Correct and isolate the scheduled model boundary

- Replace “`JUDGE.md` is the model's only prompt” with “`JUDGE.md` is the only explicit task
  prompt” until full context isolation is demonstrated.
- Define a provider-neutral scoring-adapter contract: fixed prompt, bounded input files, one
  schema-constrained output file, no credential, no network requirement, and no worker mutation.
- Prefer an inference-only adapter that does not start an agent harness. Where only an agent CLI is
  available, run it from a dedicated non-repository working directory with a dedicated runtime
  configuration that excludes user/project instructions and personal skills when the host supports
  that safely.
- Never copy, print, or inspect an agent host's authentication material to create that isolation.
  If safe isolation cannot be established, record it as unverified and make no stronger claim.
- Add at least one real-host integration test for every host marked tested. Stub tests remain useful
  for argv and stdin, but cannot establish complete model context.

Acceptance: the release record distinguishes explicit input, ambient harness context, tool access,
and filesystem/network enforcement.

### 6. Repair the public package contract

Make the v3 manifest fulfill the bootstrap page's existing promises:

- per file: `path`, `bytes`, `lines`, `sha256`, `first_line`, `last_line`;
- top level: `package`, `version`, `min_runtime_version`, `generated_for_origin`;
- archive: `path`, absolute same-origin `url`, `bytes`, `sha256`.

Add tests that fetch every manifest member, verify its digest and structural fields, extract the
archive, reject extra/missing members, and prove all origin placeholders were replaced. Update the
production release record; the current v1 record no longer describes the live v2 package.

### 7. Port package serving to TypeScript before the SPA catch-all

Implement a dedicated server module for:

- `GET /agent/`;
- `GET /agent/pkg/SETUP.md`;
- `GET /agent/pkg/VERSION` and `manifest.json`;
- exact allowlisted reference and script routes;
- the versioned deterministic archive;
- legacy redirects.

Preserve the current security properties: anonymous GET/HEAD only, exact path allowlist, no request
input reaching filesystem construction, origin substitution from trusted server configuration,
deterministic zip metadata, correct content types, public cache headers, ETags, and no cookie
variance.

Add TypeScript tests for route ordering so `/agent/*` can never fall through to `index.html`.
For one fixed origin, compare the TypeScript manifest, substituted files, and archive digest against
golden output produced by the production package builder. Expand the Docker smoke test to verify
every member rather than checking only the package name and archive digest.

### 8. Release in two controlled steps

1. Release v3 from the current Django service, exercise setup, cleanup, scheduled operation, fresh-
   package repair, and fresh-package uninstall on real macOS hardware, then update the support
   matrix honestly.
2. Vendor the exact v3 package into the TypeScript repository, record its source commit and digest,
   pass the cross-implementation golden tests, and cut over only after the complete `/agent/*` and
   `/api/v1` compatibility suites pass.

Do not maintain two independently editable package sources. After TypeScript becomes production,
move package ownership here and leave the Django copy frozen as the rollback artifact.

## Completion criteria

- No setup artifact remains after a successful install.
- `homing-setup` is absent from every skill inventory.
- `homing-check` is the only optional durable skill and can be removed without stopping the
  schedule.
- A scheduled run cannot reach setup or maintenance guidance.
- Full model-context claims are either demonstrated on the named host or explicitly qualified.
- The live manifest supports all three download ladders it documents.
- Django v3 and the TypeScript port serve byte-equivalent package contents for a fixed origin.
