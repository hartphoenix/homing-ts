# Behavioral discrepancy ledger

Precedence:

1. Security and wire requirements consumed by the unchanged agent kit.
2. Behavior explicitly included in the reviewed replacement plan.
3. Observed behavior of the current Django server.
4. Existing documentation and tests as non-normative evidence.

Every discovered conflict must receive an explicit `keep`, `change`, or `defer` resolution before
the affected implementation begins.

| Area | Evidence | Conflict | Resolution | Reason |
|---|---|---|---|---|
| Source-plan repair prompt | Django generates it in the browser layer | No JSON endpoint | change | Add bounded, private `/api/v1/me/source-plan-repair` endpoint. |
| Change cursor | Existing client persists numeric cursor | New project history starts empty | change | Introduce `<feed_epoch>:<sequence>` and return 410 for legacy cursors. |
| Browser authentication | Django uses HTML login/session | React requires JSON session bootstrap | change | Add CSRF and session endpoints while retaining agent bearer behavior. |
| Legacy test corpus | Large implementation-coupled suite | Porting would preserve cruft | defer | Replace with compact policy and journey matrix. |
| Kit manifest | Bootstrap documents fields Django omits | Fetch ladders cannot validate as documented | change | Add fields additively without changing package bytes. |
| Continuation | Client emits `next`; Django rejects it | Scheduled completion can fail | change | Accept the client's closed enum. |
| Bulk idempotency | OpenAPI/client promise it; Django ignores it | Retries can duplicate writes | change | Implement durable replay for intended mutation endpoints. |
| Project roles | Older docs call viewers read-only | Current product grants equal content authority | keep | Preserve equal collaborator content rights; owner remains administrative. |
| Complete application migration | A partial import would strand accounts or discard authored and project state | Cutover must preserve all user access and project data | change | Import every user/profile, password hash, saved prompt, project, membership, invitation, prompt revision, run history, lead, interest, comment, review, and audit row under an exact source/target checksum. |
| Migration authority state | Django sessions, tokens, links, throttles, claims, invitation digests, idempotency rows, and feed cursors are deployment-specific authority or replay state | Copying them would preserve credentials across a changed security boundary | change | Rotate them: require fresh browser login and agent pairing, revoke pending invitations for reissue, cancel active run claims, and start a new project-feed epoch. Preserve the associated historical content and identifiers where safe. |
| Legacy staff flags | Django carries staff/superuser authorization that the replacement does not implement | Reusing the flags could create accidental authority | change | Archive the booleans as explicitly nonauthorizing `legacy_is_staff`/`legacy_is_superuser` metadata. |
| Lead fallback identity | Django and TypeScript normalize query parameters differently before hashing a listing URL | Preserving the Django-derived hash would make imported rows disagree with future TypeScript deduplication | change | Recompute `identity_hash` with the TypeScript normalizer during import, reject any resulting project-local collision, and preserve the canonical/source URLs and every authored lead field. |
| Pending invitation management | Django's JSON API creates invitations but neither lists nor revokes them | The React member journey needs durable pending rows and owner cancellation | change | Include active `pending_invitations` in the member response and accept owner-only `DELETE /projects/:id/invitations` with `invitation_id`, setting `revoked_at` so the link becomes unusable. |
| Agent connection timestamps | The current TS token-list serializer omits `created_at` and `last_used_at` even though both are stored | The React connection table must show activation and recent use | change | Add both timestamps to each `/api/v1/auth/tokens` item; retain nullable `last_used_at` for keys that have never been used. |
| Lead pagination | Django returns bounded unpaginated results | Existing UI performs poorly at growth | change | Implement bounded cursor pagination from the start. |
| Dependency audit | drizzle-kit retains a legacy esbuild loader | `bun audit` reports one moderate development-server advisory | keep | Production esbuild is patched; drizzle-kit never runs in production. Recheck on toolchain upgrade. |
| Kit traversal | Fetch/Hono normalize dot segments before routing | A traversal alias can resolve to another public allowlisted kit file | keep | No request-derived filesystem join exists and traversal cannot escape the public allowlist; the security boundary is file reachability, not rejection of equivalent public paths. |
