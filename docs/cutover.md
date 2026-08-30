# TypeScript production deployment and rollback

The TypeScript application is already the production product. The v2 port extends its existing
Compose project in `/opt/homing-ts`; there is no Django cutover, importer, second public stack, or
local v1-search rollback path.

Production deployment, traffic switching, and rollback are human-authorized. Agents may prepare
or run preapproved staging commands but never handle host secrets. Keep the current web image,
schema checksum, package digest, backup artifact, and exact rollback commands in the release
record before changing production.

The recorded pre-port baseline is commit `e66cb23`, image
`sha256:a34b7cbbd526e9928c448f935df48da2c5c58bbbfb7e0430f7cd413b9727f13a`, verified healthy, with
manifest digest `a8ff9195f2c0719c5f24052010377a58d1853a948769e8d7ac2611672c88a8ba`.

## Preconditions

Run the repository preflight against the production environment file. It must validate the bare
HTTPS origin, app hostname, immutable image references, Caddyfile, role separation, and identity
file shape without printing values. The Compose database roles remain distinct: provisioner,
migration, and restricted runtime. Production public traffic enters through Caddy; PostgreSQL and
the application remain private.

Rehearse the exact release against an isolated project and database. Run the expand-only migration,
compact policy suite, real Python v2 client, package/archive verifier, browser smoke, backup, and
isolated restore. The rehearsal must also exercise web rollback to the prior TypeScript image.

The final qualification candidate is commit `ff06377`: local `bun run check` passed with 124 active
tests and 20 PostgreSQL-gated skips; the committed Python package suite passed 7/7 and the
agentation suite passed 22/22 Chromium UI tests. An isolated deployment-host rehearsal using
disposable PostgreSQL 17 and the pinned production Dockerfile build applied migrations twice and
passed all 20 PostgreSQL integration tests. The production database and service were untouched;
package/server adversarial blockers were fixed and obsolete local rollback was removed. The code
is ready to deploy. A physical native-macOS install/wake test and production canary remain
post-deploy/manual gates: they do not block deployment readiness, but they block declaring rollout
proven.

## Controlled release

1. Freeze the release commit, current image digest, schema checksum, served package digest, backup
   artifact status, disk space, and rollback commands. Confirm the failed local v1 installation has
   no job, runtime, configuration, state, skill, log, installer backup, or credential metadata. The
   former `com.homing.backup` LaunchAgent is disabled and archived; do not represent it as running
   or recreate it as part of this release.
2. Build or pull the immutable v2 image and run preflight. Take and independently verify a fresh
   encrypted PostgreSQL backup before migration.
3. Start only `db`, `provision`, `migrate`, and `harden`. Require each one-shot to exit zero and
   verify the database health. Do not start replacement web or Caddy until migration succeeds.
4. Run the old image's browser, health, and database smoke against the expanded schema. If this
   gate fails, restore the prior image and stop; do not promise a local v1 or Django recovery.
5. Force-recreate only `web` from the new immutable image. Keep PostgreSQL and Caddy running, and
   accept only the documented brief 502 window. Poll web health and run public HTTPS smoke.
6. Verify the public `/agent/` manifest, archive bytes, origin substitution, and exact setup
   document. In a fresh session, pause the account before installing, then qualify setup cleanup,
   Keychain storage, one schedule, paused self-test, resume, one manual run, delivery idempotency,
   and the factual pause/disconnect/removal controls.
7. Enable the intended maintenance and search schedules only after those checks pass. Verify exactly
   one named search job. The former backup LaunchAgent remains disabled and archived; use the
   documented manual backup command when a fresh release artifact is required, then record the
   canary result and any explicitly unverified native branches.

## Rollback

For ordinary release, canary, or web failure, pause or remove the local v2 installation, restore
the prior immutable TypeScript image digest in the environment, and force-recreate only `web`.
Verify health, public smoke, and browser behavior. Keep the new image and release backup for the
rollback window. Do not recreate Caddy or PostgreSQL unless the failure requires it, and do not
recreate the disabled backup LaunchAgent.

Use database restore only for database corruption or an explicitly approved recovery exercise.
Restore into an isolated target first, verify the encrypted archive and v2 constraints, then run
private semantic checks with web and Caddy stopped. A database restore is not an ordinary
application rollback and cannot restore a retired local v1 installation.

After seven successful scheduled v2 runs, retain the prior server image until Hart explicitly
accepts the release. Any future v1 server table/route retirement needs its own retention, restore,
and rollback plan.
