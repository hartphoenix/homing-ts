# Functional acceptance matrix

The compact replacement suite targets 71 behavioral scenarios. Parameterization may combine cases,
so test-file count is not normative. Every scenario maps to a security invariant, a browser journey,
or the unchanged Python client. The legacy Django suite is evidence only.

## Authentication and permissions — 12

1. Request IDs and the standard error envelope appear on success and failure paths.
2. Invalid explicit bearer credentials never fall back to a valid session.
3. Bearer 401 responses include the exact Homing challenge and resource metadata.
4. Login applies aggregate throttling without storing raw email or IP data.
5. Django Argon2 correct/wrong fixtures verify and rehash on success.
6. Django PBKDF2 correct/wrong fixtures verify and rehash on success.
7. Unsupported imported hashes require the documented CLI reset path.
8. Session creation, rotation, expiry, logout, and disabled-user handling.
9. Session mutations require exact Origin and a synchronizer token.
10. Invitation registration requires CSRF before an authenticated cookie exists.
11. Pairing start/poll are the only unauthenticated unsafe CSRF exemptions.
12. Token creation, project restriction, scope enforcement, listing, and revocation.

## Projects, memberships, and invitations — 12

13. Project list and detail expose only active memberships.
14. Cross-project and token-restricted objects return 404.
15. All member roles can edit content; only owners administer membership/project state.
16. Project creation assigns one owner and a unique server-generated slug.
17. Prompt updates lock revision, persist revision history, and preserve a stale draft on 409.
18. Criteria and prompt revision commit atomically with audit/change state.
19. Invitation creation binds normalized email, role, expiry, and digest-only token.
20. Authenticated exact-email invitation acceptance is retained.
21. Invitation-bound registration creates the user/profile/membership transactionally.
22. Expired, revoked, consumed, and wrong-email invitations cannot be reused.
23. Role changes enforce at least one final owner under concurrent attempts.
24. Member removal and project trash enforce owner and isolation rules.

## Leads and collaboration — 17

25. Lead lists paginate deterministically for every supported q/status/interest/sort combination.
26. Lead detail exposes integer author/comment IDs and current revision/ETag.
27. Create validates the closed field schema and canonicalizes fallback URL identity.
28. Source plus source-listing ID is the primary project-local identity.
29. Duplicate create/upsert resolves to the existing identity without duplicate rows.
30. Partial update leaves omitted fields unchanged.
31. Stale revision/If-Match returns 409 and does not discard submitted draft data.
32. Trashed leads reject agent updates with the expected per-item conflict.
33. Bulk upsert returns one ordered result for each of 1–100 input items.
34. Bulk upsert isolates per-item validation/conflict outcomes without aborting valid items.
35. Idempotency replays identical create/bulk requests and rejects key reuse with changed input.
36. Batch create/upsert/trash/restore preserves ordering and policy boundaries.
37. Trash/restore permissions, state transitions, audit, and change events are atomic.
38. Permanent lead destruction requires its dedicated scope and owner policy.
39. Interest set/unset is user-local, idempotent, and reflected in filters/counts.
40. Comment create/edit/delete enforces author/moderator rules and soft deletion.
41. Parent comments remain on the same lead and inaccessible projects remain opaque.

## Runs, change feed, and source-plan reviews — 14

42. Run creation snapshots the exact current prompt revision, prompt, and criteria.
43. Run-create idempotency is principal/project/request bound.
44. Only one live project lease exists; expired leases can be reclaimed transactionally.
45. Claim, heartbeat, and complete reject wrong, expired, or digested-only claim tokens.
46. Completion requires idempotency and the unchanged client's closed continuation schema.
47. Completion accepts `continuation.next` and drops deprecated `next_query` with notice.
48. Result counts, summary sanitation, and bounds match the unchanged client.
49. Fresh empty change feeds return and persist `<feed_epoch>:0`.
50. Legacy numeric and wrong-epoch cursors return 410 `cursor_expired`.
51. Fresh, paginated, no-change, and post-mutation feeds advance monotonically.
52. Review report opens or refreshes one user/project row without change-feed content.
53. Review resolve enforces current/observed revisions and is idempotent for the same revision.
54. Review wire objects contain exactly the eight client-consumed fields.
55. Repair guidance is private/no-store, origin-only, bounded, and contains no user content.

## Public kit and unchanged client — 8

56. Public GET/HEAD allowlist rejects unknown names, version mismatch, and nesting; normalized
    traversal cannot escape the public allowlist (an alias of an already-public file is harmless).
57. Origin substitution leaves no placeholder and never mutates vendored source files.
58. Manifest fields, digests, lines, first/last line, runtime, and archive URL are exact.
59. ZIP ordering, timestamps, modes, compression, and bytes are deterministic.
60. Cache headers, strong ETags, weak/list/star conditional requests, and 304 bodies are exact.
61. Extracted installer completes with scheduler/runtime disabled and refuses another origin.
62. Real pair-request/poll stores a 0600 token without leaking codes or credentials.
63. Real client executes cursor reset, run/lease/upsert/comment/complete, and review repair paths.

## Browser journeys — 8

64. Login/logout and expired-session recovery work with keyboard and mobile layouts.
65. Project/prompt/criteria editing reports conflicts without losing edits.
66. Lead list/cards preserve URL state across search/filter/sort/view and pagination.
67. Lead detail supports interest, comments, edit, trash, and restore by policy.
68. Members and invitation administration expose final-owner errors clearly.
69. Profile and server-side agent pause state update and rehydrate.
70. Agent setup supports link approval/denial plus manual token creation and revocation.
71. Source-plan review banner shows count, state, and server-authored copyable repair guidance.
