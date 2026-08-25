# Cutover and rollback

The Django deployment stays intact at `/opt/homing`; the replacement lives at `/opt/homing-ts`.
Their Compose projects, database volumes, Caddy volumes, and networks are distinct. Only one Caddy
may own public ports 80/443 at a time.

Production deployment, traffic switching, and rollback are human-authorized operations. Agents may
prepare commands and run preapproved staging commands, but do not handle host secrets.

The web container starts only after the one-shot `migrate` service completes successfully. Do not
use Compose `--wait` on a graph containing `provision`, `migrate`, or `harden`: the production
Compose version can return nonzero because those successful one-shots are exited. Start the graph
detached, require each one-shot to finish with exit code zero, and inspect long-running service
health separately. Import and validation commands that intentionally run against a stopped or
isolated database must use the least-privileged service appropriate to the operation: `migrate` for
schema/import work and `web` only for runtime reads and writes.

For production, `PUBLIC_ORIGIN` must be a bare HTTPS origin (for example,
`https://homing.example.test`) and `APP_DOMAIN` must be the bare public hostname (for example,
`homing.example.test`) so Caddy can manage TLS. The application rejects non-HTTPS production
origins except `localhost` for the private HTTP rehearsal below, and rejects
`HOMING_DEMO_ACCOUNTS=1` in production. Compose explicitly sets demo seeding to `0`; do not override
that value in a production environment file.

The Compose database contract has three distinct roles. `DATABASE_ADMIN_URL` binds the initial
`POSTGRES_USER`/`POSTGRES_PASSWORD` and is used only by the one-shot `provision` service;
`DATABASE_MIGRATION_URL` binds `POSTGRES_MIGRATION_USER`/`POSTGRES_MIGRATION_PASSWORD` and is used
only by Drizzle migrations; `DATABASE_URL` binds the separate `POSTGRES_APP_USER`/
`POSTGRES_APP_PASSWORD` and is the only database URL given to web. The provisioner grants web DML
and sequence privileges, but no role/database/schema DDL privileges. Preflight rejects role reuse and
URL/credential/host mismatches without printing values.

Run the preflight from the release checkout before starting the production Compose project. It
validates these values and any configured identity file without printing them. Because Git does not
preserve `0644` versus `0600` for non-executable files, normalize the public Caddyfile after any
checkout created under a restrictive umask. Preflight requires an owned, regular, non-symlink
mode-0644 Caddyfile, rejects ACME email configuration that can fail only during certificate
issuance, and validates the file in the exact pinned Caddy image without opening network ports. The
private HTTP localhost rehearsal below intentionally uses different values and does not pass this
production preflight:

```sh
chmod 0644 Caddyfile
./docker/preflight.sh .env
```

## Private rehearsal

Use a persistent mode-0600 `.env.rehearsal` with a distinct `COMPOSE_PROJECT_NAME`, database name,
roles, passwords, ports, and origin. Compose resources are project-scoped, so this creates separate
database, network, and Caddy state. Every rehearsal command must use that file via `--env-file` or
`HOMING_ENV_FILE`; there are no transient shell overrides to lose. `compose.yaml` has no implicit
build step: `up` consumes only the image reference already prepared for the release.

The currently verified upstream minor tags are PostgreSQL `17.11-alpine3.24` and Caddy
`2.11.4-alpine`. Resolve each to its multi-architecture manifest digest during release
preparation (`docker buildx imagetools inspect ...`) and record the resulting `@sha256:` values in
the environment file. Build and publish Homing to a registry and record its registry digest, or
build the release commit on the production host and record its exact local `sha256:<image-id>`.
Preflight rejects tags; PostgreSQL and Caddy require registry digests, while Homing accepts either
a registry digest or a content-addressed local image ID.

```sh
chmod 600 .env.rehearsal
rehearsal_compose() { docker compose --env-file .env.rehearsal "$@"; }
rehearsal_compose up --detach
for service in provision migrate harden; do
  container=$(rehearsal_compose ps --all -q "$service")
  test -n "$container"
  test "$(docker wait "$container")" = 0
  test "$(docker inspect "$container" --format '{{.State.Status}}:{{.State.ExitCode}}')" = exited:0
done
for service in db web; do
  container=$(rehearsal_compose ps --status running -q "$service")
  test -n "$container"
  for _ in $(seq 1 45); do
    test "$(docker inspect "$container" --format '{{.State.Health.Status}}')" = healthy && break
    sleep 2
  done
  test "$(docker inspect "$container" --format '{{.State.Health.Status}}')" = healthy
done
```

At minimum, `.env.rehearsal` contains `COMPOSE_PROJECT_NAME=homing-ts-rehearsal`, distinct database
credentials, `HOMING_HTTP_PUBLISH=127.0.0.1:8081`,
`HOMING_HTTPS_PUBLISH=127.0.0.1:8444`,
`HOMING_HTTPS_UDP_PUBLISH=127.0.0.1:8444`, `APP_DOMAIN=http://localhost`,
`PUBLIC_ORIGIN=http://localhost:8081`, and the three immutable image references. Keep every other
required Compose value in that same file.

Run migrations, the compact API suite, real unchanged-client checks, migration validation, backup,
isolated restore, and `docker/smoke.sh` before approving cutover. Invoke the scripts with
`HOMING_ENV_FILE=.env.rehearsal`; they read the project name and immutable images from the file.
Local backup retention and off-host uploads are automatically nested beneath that project name.
Rehearsal data and recovery artifacts do not share the production namespaces.

After restore, the script leaves web and Caddy stopped. Start the rehearsal Caddy only on its
localhost ports, run semantic checks and smoke, then make the human decision to start public Caddy:

```sh
rehearsal_compose() { docker compose --env-file .env.rehearsal "$@"; }
rehearsal_compose up --detach web caddy
for _ in $(seq 1 45); do
  ./docker/smoke.sh http://localhost:8081 && break
  sleep 2
done
./docker/smoke.sh http://localhost:8081
```

For production, build or pull the release-specific image, run preflight, then start only the
private database/migration chain. Do not start web or Caddy before the frozen import validates:

```sh
docker pull <registry>/homing@sha256:<release-manifest-digest>
./docker/preflight.sh .env
prod_compose() { docker compose --project-name homing-ts --env-file .env "$@"; }
prod_compose up --detach db provision migrate harden
for service in provision migrate harden; do
  container=$(prod_compose ps --all -q "$service")
  test -n "$container"
  test "$(docker wait "$container")" = 0
  test "$(docker inspect "$container" --format '{{.State.Status}}:{{.State.ExitCode}}')" = exited:0
done
db_container=$(prod_compose ps --status running -q db)
test -n "$db_container"
test "$(docker inspect "$db_container" --format '{{.State.Health.Status}}')" = healthy
```

The production `.env` must persist the exact Homing, PostgreSQL, and Caddy digest references; this
also lets unattended backup timers parse the complete Compose model.

Before admitting public traffic, install a daily host timer for bounded database cleanup and verify
one successful run. The timer runs from `/opt/homing-ts` with the production environment file:

```sh
docker compose --project-name homing-ts --env-file .env \
  run --rm --no-deps web bun run db:maintenance
```

Run the encrypted backup timer under the same host account. Both jobs must alert on nonzero exit;
maintenance logs only redacted deletion counts, and backups select their project-scoped namespace
from the persistent environment file.

## Production switch

1. Record the intended release commit and verify public ports, disk space, image availability, and
   both rollback checkouts. Start only replacement `db`, `provision`, `migrate`, and `harden`; prove
   that the runtime role cannot mutate `migration_records` and leave replacement web/Caddy stopped.
2. Stop Django Caddy and web traffic. Record this freeze timestamp. Keep the Django database up but
   admit no writes.
3. Take the final encrypted Django backup from the frozen database. Verify its encrypted envelope;
   verify dump inventory during the isolated restore rehearsal, because routine backup does not
   require the offline recovery identity.
4. Run the guarded import script with the freeze timestamp. It attaches Django PostgreSQL to the
   replacement database network under a random alias, creates a random read-only SCRAM role,
   inherits the source URL without putting it in command history, runs import and independent
   validation, then drops the role and disconnects the bridge even on failure:

   ```sh
   export MIGRATION_CUTOVER_AT=<recorded-UTC-freeze-timestamp>
   HOMING_ENV_FILE=/opt/homing-ts/.env DJANGO_PROJECT_DIR=/opt/homing \
     /opt/homing-ts/docker/import-frozen-django.sh
   unset MIGRATION_CUTOVER_AT
   ```

5. Require
   identical canonical source/target checksums and counts for all users/profiles, saved prompts,
   projects/memberships/invitations/revisions, runs, leads/interests/comments, reviews, and audits.
   Confirm the reported rotation counts for sessions, tokens, links, throttles, idempotency rows,
   change-feed rows, active run claims, and pending invitations. Require zero active users needing
   password reset and record the count of pending invitations needing reissue.
6. Start web through the loopback-only override; keep Caddy stopped:

   ```sh
   private_compose() {
     docker compose --project-name homing-ts --env-file .env \
       -f compose.yaml -f compose.private.yaml "$@"
   }
   private_compose up --detach web
   web_container=$(private_compose ps --status running -q web)
   test -n "$web_container"
   for _ in $(seq 1 45); do
     test "$(docker inspect "$web_container" --format '{{.State.Health.Status}}')" = healthy && break
     sleep 2
   done
   test "$(docker inspect "$web_container" --format '{{.State.Health.Status}}')" = healthy
   SMOKE_EXPECTED_ORIGIN=https://homing.hartphoenix.com \
     ./docker/smoke.sh http://127.0.0.1:18000
   ```

   In this private phase, perform only reads: rerun canonical count/checksum validation, inspect each
   user's project memberships and roles, preserve both project UUIDs, inspect
   lead/comment/interest/trash state, check read-only API isolation, and load the public agent-kit
   files. Loopback requests cannot satisfy the production Origin contract for browser mutations.
   Also take a new encrypted replacement backup and prove it with an isolated restore. All browser
   sessions are intentionally fresh after deployment.
7. Rehearse the rollback command from the running replacement. Keep public Caddy stopped until the
   private read-only checks and smoke pass. Remove the private port by stopping web and recreating it
   from the base Compose file, verify it has no published port, then start Caddy on public ports:

   ```sh
   private_compose() {
     docker compose --project-name homing-ts --env-file .env \
       -f compose.yaml -f compose.private.yaml "$@"
   }
   prod_compose() {
     docker compose --project-name homing-ts --env-file .env -f compose.yaml "$@"
   }
   private_compose stop web
   prod_compose up --detach --no-deps --force-recreate web
   web_container=$(prod_compose ps --status running -q web)
   test -n "$web_container"
   for _ in $(seq 1 45); do
     test "$(docker inspect "$web_container" --format '{{.State.Health.Status}}')" = healthy && break
     sleep 2
   done
   test "$(docker inspect "$web_container" --format '{{.State.Health.Status}}')" = healthy
   port_bindings=$(docker inspect "$web_container" --format '{{json .HostConfig.PortBindings}}')
   case "$port_bindings" in null|'{}') ;; *) exit 1 ;; esac
   prod_compose up --detach --no-deps caddy
   for _ in $(seq 1 45); do
     ./docker/smoke.sh https://homing.hartphoenix.com && break
     sleep 2
   done
   ./docker/smoke.sh https://homing.hartphoenix.com
   ```

8. While Django remains frozen and schedules remain disabled, verify an existing-password login and
   the core browser journeys over the public HTTPS origin. Reissue any pending invitations. Re-pair
   each installed agent without adding another schedule; confirm project discovery retains its UUID,
   replace the token in the secret store, run source-plan repair and one on-demand search, and verify
   the results. Only after those checks pass, enable the maintenance, backup, and search schedules and
   confirm exactly one of each intended schedule exists.

If any validation before public step 7 fails, stop the replacement and restart Django web and Caddy.
If a public step-8 check fails, freeze replacement traffic before choosing rollback; account for any
replacement-side writes under the divergence rule below.

## Rollback

Stop replacement Caddy and web, then start Django web and Caddy against the preserved old database
volume. Keep the old encrypted backup, checkout, image, and named volume for at least seven days.

Writes accepted by the replacement do not exist in Django. If any occurred, rollback deliberately
abandons them unless a separate reconciliation is designed and tested. Hart chooses whether that
data divergence is acceptable before rollback.
