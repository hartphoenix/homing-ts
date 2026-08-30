# Homing agent kit v2 build specification

Status: v2 implementation candidate; native and database qualification pending.

## Contract succession

This specification governs the v2 agent kit and its TypeScript server slice. Its normative order
is:

1. the revised v2 agent-kit and search contract;
2. this specification and [the acceptance matrix](acceptance-matrix.md);
3. existing Homing behavior outside the agent-kit contract;
4. the Django v2 implementation as behavioral evidence;
5. v1 behavior as rollback evidence only.

The current TypeScript product is the canonical server, package publisher, lifecycle UI, and
production deployment target. The v2 port does not transplant Django, restore a Django deployment,
or depend on v1 execution abstractions. The API route inventory and OpenAPI document are derived
contract artifacts and must remain synchronized with this specification as implementation proceeds.

## Verified production baseline

The pre-port production baseline is healthy and remains the rollback reference for the TypeScript
web image:

- application commit: `e66cb23`;
- image: `sha256:a34b7cbbd526e9928c448f935df48da2c5c58bbbfb7e0430f7cd413b9727f13a`;
- health: verified healthy;
- served package manifest digest: `a8ff9195f2c0719c5f24052010377a58d1853a948769e8d7ac2611672c88a8ba`.

This baseline predates the v2 port. It is a server rollback reference, not a promise to restore a
retired local v1 installation or a Django deployment.

## Product boundary

Keep one Hono application and one PostgreSQL database. Add one isolated v2 agent
router/service/repository slice at the existing composition seam. PostgreSQL is product truth for
canonical prompt and source-query revisions, connection authority, run reports, stable leads,
observations, audit, and idempotency. The runner's private SQLite file is only a recoverable work
queue and delivery ledger; it contains no prompt text or source configuration.

Reuse existing sessions, CSRF, bearer isolation, project membership, audit/change transactions,
lead identity, package serving, React, PostgreSQL/Drizzle, Caddy, image, backup, restore, health,
and deployment-lock primitives. Do not add a second credential system, product database, or local
configuration replica.

## v2 schema and canonical configuration

Use an expand-only Drizzle migration. Add protocol versioning, the user-wide `agent_paused_until`,
temporary source-write expiry, a current project configuration pointer, complete prompt revisions,
immutable source-query revisions and references, a distinct v2 run table, and immutable match
observations. Existing prompt revisions remain immutable `legacy`; existing project projections
remain unchanged and current v2 pointers start null. Do not infer v2 requirements or queries from
legacy prose.

Generate canonical UTF-8 JSON once, store its exact bytes and SHA-256, and return those bytes
directly with the digest as ETag. Prompt/configuration edits and compatibility projections commit
with the existing audit/change event. Text-only edits carry forward confirmed requirements and
query references; acquisition-field edits create replacement queries marked `needs_review` and
stop unattended acquisition until attended refresh confirms them. The runner stores revision IDs
and hashes, not configuration payloads.

## Authority and operations

Pairing declares protocol v2 before browser approval. The initial credential has exactly
`agent-config:read`, temporary `source-config:write`, `agent-runs:write`,
`agent-deliveries:write`, and `connection:self`. The initial source-write grant expires after 30
minutes; setup finalization consumes it. A browser may regrant the same connection for 15 minutes.
Pause is user-wide and reversible for 14 days. Disconnect revokes only the calling connection and
does not claim to remove local files.

The closed v2 route contract is the route inventory's source of implementation detail: pairing,
introspection, self-disconnect, setup finalization, project/configuration reads and writes,
run-create/finalize, create-or-return-existing delivery, browser pause, and browser source refresh.
Every route enforces project isolation, scope and CSRF boundaries, typed authentication,
authorization, validation, conflict, throttling, and availability errors.

Run creation snapshots immutable revisions by invocation UUID. Finalization is idempotent and
validates ownership, hashes, allowed transitions, bounded counts, and the rule that `completed`
has no nonterminal query, candidate, or delivery. It does not claim to prove external exhaustion.
Delivery never overwrites human-edited lead fields and records a match observation idempotently.

## Package and lifecycle

The public package uses top-level `SETUP.md`, with no top-level `SKILL.md` or Agent Skill
frontmatter. Only the optional installed `homing-check/SKILL.md` is a durable skill. Setup is
attended, manifest-owned, reversible, and removes its verified temporary workspace after success;
unexpected residue is reported. The scheduler invokes only the generated worker. The worker never
changes its prompt, cadence, sources, executable code, or permissions.

Serve v2 at `/agent/`, preserve deterministic archives, manifest fields, ETags, origin
substitution, HEAD behavior, and exact member allowlists. Legacy setup-skill URLs may redirect to
`SETUP.md`, but a setup `SKILL.md` is not an archive member.

## Qualification and deployment

Qualification must cover canonical bytes, schema constraints, PostgreSQL authorization and
idempotency, the complete real Python v2 runner, package reproducibility, pause/disconnect/remove,
truthful incomplete outcomes, browser lifecycle state, backup/restore, and rollback to the prior
TypeScript image. No local v1-search rollback path exists. Do not claim Django migration, VM
coverage, Claude Code support, or native branches not actually exercised.

Production uses one immutable TypeScript image and the existing Compose topology. Run the
expand-only migration while the prior web image remains available, force-recreate only web after
the migration succeeds, and retain the prior image through the rollback window. Database restore
is reserved for corruption; ordinary canary failure rolls back the prior TypeScript image and
pauses or removes the local v2 installation.
