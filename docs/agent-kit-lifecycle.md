# Agent-kit lifecycle

The kit has three distinct layers.

| Layer | Lifetime | Location | Loaded by daily runs |
|---|---|---|---|
| Setup prompt and probes | One setup or repair session | Verified `homing-agent-kit-*` temporary directory | Never |
| Scheduled worker | Until uninstall | OS config, state, log, and scheduler directories | Directly by the scheduler |
| Interactive `homing-check` skill | Optional, until uninstall | Shared or host-specific skill root | Only when an interactive request matches it |

`SETUP.md` is fetched explicitly. It is not a discoverable skill. A verified byte-exact package
is initialized by `scripts/finalize.py`; success removes it with `--finalize`, while a stopped
setup removes it with `--discard`. Repair and assisted uninstall fetch fresh packages instead of
retaining setup machinery.

The scheduled runner pins `<config>/prompts/JUDGE.md` directly. The optional skill contains only
the on-demand command and result-reporting contract. `runtime.install_skill: false` produces a
scheduler-only installation with no skill-directory writes.

The TypeScript server builds the package manifest and deterministic zip from
`agentkit/package/`. `/agent/` and `/agent/pkg/*` support GET and HEAD without authentication;
other methods return 405. Legacy setup-skill URLs redirect to `SETUP.md`.

## Agent portability contract

The setup mechanism is agent-agnostic because it is an explicitly fetched Markdown prompt plus
black-box scripts. It does not depend on skill discovery. Only the optional daily facade depends on
an agent's skill root.

Discovery paths are version-sensitive. The support table in `SETUP.md` records documented,
untested capability rather than claiming conformance. Sources checked on 2026-08-22:

- [Codex skill discovery](https://learn.chatgpt.com/docs/build-skills)
- [Claude Code skills](https://code.claude.com/docs/en/slash-commands)
- [Gemini CLI skill discovery](https://geminicli.com/docs/cli/using-agent-skills/)
- [Cursor Agent Skills](https://cursor.com/docs/skills)
- [GitHub Copilot CLI skill locations](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [OpenCode Agent Skills](https://opencode.ai/docs/skills)

These sources currently document `~/.agents/skills` for Codex, Gemini CLI, Cursor, GitHub Copilot
CLI, and OpenCode. Claude Code documents `~/.claude/skills`. The installer can use one canonical
portable copy plus a host-specific copy or link, but each agent remains untested until a pinned
Tier D adapter proves discovery and invocation.

The local Tier A/B suite currently proves:

- deterministic manifest/member/archive integrity and route behavior;
- skill-present and scheduler-only installs from the exact server-built artifact;
- package substitution, unowned collision, contained-manifest substitution, symlink-swap, and
  hard-link refusal;
- exact uninstall that preserves foreign siblings;
- canonical-manifest binding for destructive actions and strict completed-install proof before
  setup finalization;
- deterministic removal of verified legacy `homing-setup` directories across portable and
  host-specific roots while preserving lookalikes and links;
- 77 fresh-install and 72 repair mutation checkpoints, including scheduler compensation and
  byte-identical repair rollback;
- finalization of only an initialized package with a durable worker;
- environment allowlisting, planted leak/mutation detection, process-group timeout, ledger escape
  refusal, and symlink cleanup refusal.

Tier C passes locally for two non-root Debian personas: the Python 3.9 floor and current Python
3.14, both pinned by architecture-specific image digest. Each exercises scheduler-only and optional-skill
installs, self-tests, finalizes before every daily process, runs three daily cycles across a fresh
repair package, runs the complete mutation checkpoint matrix, checks that the target UID cannot
read the root-owned setup source, uninstalls while preserving foreign siblings, refuses root and
home manifest substitution, and audits product and harness residue over a strict private HTTPS
fixture network. A first-time persona separately proves the missing-Python probe path mutates no
product state. The run passed using a dedicated mount-free Colima profile and an explicit socket;
the controller did not alter the developer's active Docker context. The final exact artifact had
manifest SHA-256 `9d76d026aef4129a2efe645588537dd3f880d4c25a362c74154608f07819b426`;
calibration, product, product-residue, harness-cleanup, and boundary-audit all returned `PASS`.
Protocol-error, signal, and native-scheduler expansion rows remain unexecuted and are not included
in the Tier C pass claim.
The result reports each expansion ID separately: `probe_environment_errors`,
`pairing_helper_errors`, `selftest_failure`, `daily_protocol_errors`,
`finalize_deletion_denial`, `controller_term`, `graceful_cancel`, `target_term`, and
`target_kill_or_host_crash`.

Real scheduler registration, OS credential stores, a real-agent setup session, and native
macOS/Linux/Windows release behavior remain explicit Tier D/E gaps. Their commands are guarded and
do not claim support from the fake model or portable filesystem tests. See
[`agent-workflow-testing.md`](agent-workflow-testing.md).
