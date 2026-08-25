# Cutover and rollback

The Django deployment stays intact at `/opt/homing`; the replacement lives at `/opt/homing-ts`.
Their Compose projects, database volumes, Caddy volumes, and networks are distinct. Only one Caddy
may own public ports 80/443 at a time.

Production deployment, traffic switching, and rollback are human-authorized operations. Agents may
prepare commands and run preapproved staging commands, but do not handle host secrets.

The web container starts only after the one-shot `migrate` service completes successfully. A normal
`docker compose --env-file .env up --detach --wait` therefore applies pending Drizzle migrations
before health checks can admit web traffic. Import and validation commands that intentionally run
against a stopped or isolated database must use the least-privileged service appropriate to the
operation: `migrate` for schema/import work and `web` only for runtime reads and writes.

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
validates these values and any configured identity file without printing them. The private HTTP
localhost rehearsal below intentionally uses different values and does not pass this production
preflight:

```sh
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
the environment file. Build and publish Homing to a registry, then record its registry digest too.
Preflight rejects tags and requires all three references to end in `@sha256:<64 lowercase hex>`.

```sh
chmod 600 .env.rehearsal
docker compose --env-file .env.rehearsal up --detach --wait
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
docker compose --env-file .env.rehearsal up --detach --wait web caddy
./docker/smoke.sh http://localhost:8081
```

For production, build or pull the release-specific image before `up`, then run preflight and use
the same immutable image value for migration and web:

```sh
docker pull <registry>/homing@sha256:<release-manifest-digest>
./docker/preflight.sh .env
docker compose --env-file .env up --detach --wait
```

The production `.env` must persist the exact Homing, PostgreSQL, and Caddy digest references; this
also lets unattended backup timers parse the complete Compose model.

Before admitting public traffic, install a daily host timer for bounded database cleanup and verify
one successful run. The timer runs from `/opt/homing-ts` with the production environment file:

```sh
docker compose --env-file .env run --rm --no-deps migrate bun run db:maintenance
```

Run the encrypted backup timer under the same host account. Both jobs must alert on nonzero exit;
maintenance logs only redacted deletion counts, and backups select their project-scoped namespace
from the persistent environment file.

## Production switch

1. Record the intended release commit and verify public ports, disk space, image availability, and
   both rollback checkouts.
2. Stop Django Caddy and web traffic. Record this freeze timestamp. Keep the Django database up but
   admit no writes.
3. Take the final encrypted Django backup from the frozen database. Verify its encrypted envelope;
   verify dump inventory during the isolated restore rehearsal, because routine backup does not
   require the offline recovery identity.
4. Initialize the empty replacement database, run Drizzle migrations, and import from the frozen
   Django snapshot through the `migrate` service. Preserve both user IDs and the project UUID.
   Run `db:validate-import` through that same isolated service.
5. Start the replacement privately and verify both migrated memberships, Hart's login if desired,
   API isolation, the agent kit, a new encrypted backup, and an isolated restore of that backup.
6. Re-pair each installed agent without adding another schedule. Confirm project discovery retains
   the project UUID, replace the token in the secret store, run source-plan repair and one on-demand
   search, then confirm exactly one schedule remains.
7. Rehearse the rollback command from the running replacement. Keep public Caddy stopped until the
   private semantic checks and smoke pass, then start it on public ports and repeat the smoke check
   and core browser journeys.

If any validation before step 7 fails, stop the replacement and restart Django web and Caddy before
admitting writes.

## Rollback

Stop replacement Caddy and web, then start Django web and Caddy against the preserved old database
volume. Keep the old encrypted backup, checkout, image, and named volume for at least seven days.

Writes accepted by the replacement do not exist in Django. If any occurred, rollback deliberately
abandons them unless a separate reconciliation is designed and tested. Hart chooses whether that
data divergence is acceptable before rollback.
