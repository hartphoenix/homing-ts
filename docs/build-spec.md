# Homing replacement build specification

Status: local functional candidate; private deployment and cutover rehearsal pending.

## Outcome

The replacement preserves the agent-facing API, authorization model, collaborative project
semantics, and unchanged public agent-kit while replacing Django templates and server code with a
Bun/Hono/React application.

## Initial browser product

Included: sessions, invitation-bound registration, projects, prompt/criteria, leads, interest,
comments, trash/restore, memberships, profile/pause, agent setup/link approval, manual tokens, and
source-plan repair guidance.

Deferred: saved prompts UI, general password-reset UI, public registration, and admin UI.

Account recovery is deliberately CLI-only in the initial release. `bun run db:reset-password --
--email <address>` requires an interactive TTY, reads the new password without echo or argv/env
exposure, and writes a pinned Argon2id hash. It is the repair path for unsupported imported hashes.

## Migration boundary

Migrate user identity/profile/password hashes, active project configuration and UUID, current
prompt revision, and memberships. Do not migrate lead/search history, tokens, sessions, links,
saved prompts, audit events, or change history.

## Release priority

Functional correctness, security, compact compatibility tests, backup/restore, and rollback are
Tier 1. Performance profiling begins only after the functional release candidate is complete.

## Contract decisions

- The unchanged `agentkit/package/scripts/homing.py` client is the primary wire-contract consumer.
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
- `GET/PATCH /api/v1/me/profile` owns private search context and `agent_paused_until`.
  `/api/v1/me/token` and `/api/v1/me/projects` surface that pause to scheduled agents immediately.
- Device pairing begins and polls without credentials. A browser session inspects and decides the
  six-character code through `/api/v1/auth/agent-links/:code`; the paired token is disclosed once
  and never receives `leads:destroy`.
