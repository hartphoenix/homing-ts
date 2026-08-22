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
| Membership migration | Fresh database would require partner onboarding | Partner need not participate in rewrite | change | Import existing users/project/memberships and rehash passwords on later login. |
| Pending invitation management | Django's JSON API creates invitations but neither lists nor revokes them | The React member journey needs durable pending rows and owner cancellation | change | Include active `pending_invitations` in the member response and accept owner-only `DELETE /projects/:id/invitations` with `invitation_id`, setting `revoked_at` so the link becomes unusable. |
| Agent connection timestamps | The current TS token-list serializer omits `created_at` and `last_used_at` even though both are stored | The React connection table must show activation and recent use | change | Add both timestamps to each `/api/v1/auth/tokens` item; retain nullable `last_used_at` for keys that have never been used. |
| Lead pagination | Django returns bounded unpaginated results | Existing UI performs poorly at growth | change | Implement bounded cursor pagination from the start. |
| Dependency audit | drizzle-kit retains a legacy esbuild loader | `bun audit` reports one moderate development-server advisory | keep | Production esbuild is patched; drizzle-kit never runs in production. Recheck on toolchain upgrade. |
