# Homing replacement build specification

Status: release candidate; production migration rehearsal and cutover pending.

## Outcome

The replacement preserves the agent-facing API, authorization model, collaborative project
semantics, and unchanged public agent-kit while replacing Django templates and server code with a
Bun/Hono/React application.

## Initial browser product

Included: sessions, invitation-bound registration, projects, prompt/criteria, leads, interest,
comments, trash/restore, memberships, profile, agent setup/link approval, manual tokens, and
source-plan repair guidance.

Deferred: saved prompts UI, general password-reset UI, public registration, and admin UI.

Account recovery is deliberately CLI-only in the initial release. `bun run db:reset-password --
--email <address>` requires an interactive TTY, reads the new password without echo or argv/env
exposure, and writes a pinned Argon2id hash. It is the repair path for unsupported imported hashes.

## Migration boundary

Migrate every user and profile, password hash, active/disabled state, last login, nonauthorizing
legacy staff metadata, saved prompt, project and membership, invitation record, prompt revision,
search-run history, lead (including trash state), interest, comment, source-plan review, and audit
event. Preserve numeric IDs, UUIDs, roles, timestamps, and authored content.

Do not carry live authority or replay state across the trust boundary. Browser sessions, auth
throttles, agent tokens, device links, idempotency rows, and the legacy change feed are rotated.
Every project starts a fresh feed epoch at sequence zero. Every run drops token references, claims,
leases, and idempotency keys; active run statuses additionally become cancelled historical rows.
Token references in reviews and audits are cleared. Existing invitation rows remain as history,
but unused invitation digests are tombstoned and pending invitations are revoked for explicit
reissue after cutover.

The importer reads Django in a repeatable-read, read-only transaction and accepts only a completely
empty target. It validates referential closure, active ownership, prompt history, comment trees,
target bounds, and URL-identity collisions before writing. Before commit it rereads the target and
requires an exact canonical checksum match; the separate validator independently rereads both
databases and checks counts, checksums, migration records, fresh sessions, and feed epochs.
Cutover is blocked if any active user has a password hash the replacement cannot verify.

## Release priority

Functional correctness, security, compact compatibility tests, backup/restore, and rollback are
Tier 1. Performance profiling begins only after the functional release candidate is complete.

## Contract decisions

- The versioned `agentkit/package/scripts/homing.py` client is the primary wire-contract consumer.
- Browser administration and all account/project administration are session-only.
- Every active member role may edit project content. Owner status governs membership administration,
  project trash, comment moderation, and the final-owner invariant.
- Disabled password-token exchange and public registration are omitted. Invitation-bound
  registration is retained.
- Lead create, bulk upsert, comment create, and run completion implement durable idempotency even
  where Django currently ignores the header.
- `continuation.next` is accepted because the unchanged client emits it. Deprecated `next_query`
  is accepted and dropped with a deprecation header.
- `continuation_from_run_id` is accepted as a compatibility no-op; the installed runtime does not
  use it.
- Change cursors are `<feed_epoch>:<sequence>`. A legacy numeric or wrong-epoch cursor returns the
  existing `410 cursor_expired` envelope. A fresh empty feed returns `<feed_epoch>:0`.
- User and comment identifiers remain integer/bigint. Project, token, run, lead, and review IDs are
  UUIDs.
- The public kit manifest adds `first_line`, `last_line`, top-level `min_runtime_version`, and
  `archive.url`, repairing promises already made by the unchanged bootstrap page.

## API invariants

- JSON bodies are limited to 2 MiB; bulk lead requests contain 1–100 items.
- Every response includes `X-Request-ID`. Invalid bearer responses include the Homing
  `WWW-Authenticate` resource metadata.
- An explicit invalid Authorization header never falls back to a browser session.
- Bearer unsafe calls bypass CSRF. Cookie-authenticated unsafe calls require exact Origin and a
  synchronizer token.
- Inaccessible, trashed, or token-restricted projects return 404; known accessible projects with
  insufficient scope return 403.
- Prompt and lead updates are optimistic and return 409 without discarding the submitted draft.
- Project change, audit, and mutation writes commit together.
- Production accepts browser traffic only through Caddy. Caddy overwrites `X-Forwarded-For` with
  its observed client address before forwarding to the unexposed application container.

## Browser identity contract

- `GET /api/v1/csrf` creates or refreshes the synchronizer token. Login, registration, profile
  updates, invitation acceptance, token administration, and pairing decisions require that token
  plus the exact configured Origin.
- `POST /api/v1/invitations/:token/register` is the only registration path. It atomically creates
  the invited user and profile, creates the project membership, and consumes the invitation.
  Existing exact-email recipients instead sign in and use `POST /api/v1/invitations/:token/accept`.
- `GET/PATCH /api/v1/me/profile` owns private search context.
- Device pairing begins and polls without credentials. A browser session inspects and decides the
  six-character code through `/api/v1/auth/agent-links/:code`; the paired token is disclosed once
  and never receives `leads:destroy`.
