# Backup and restore

Production backups are PostgreSQL custom dumps encrypted in flight with `age`. Plaintext dumps are
never written to disk. Off-host upload is optional and happens only after encryption.

Required `.env` settings:

- `DATABASE_ADMIN_URL`: the database owner URL used only by the one-shot role provisioner; it binds
  the initial `POSTGRES_USER`/`POSTGRES_PASSWORD` to host `db`. Backup and restore authenticate over
  container-local TCP with that initial role and password.
- `DATABASE_MIGRATION_URL`: the URL used only by Drizzle migrations.
- `DATABASE_URL`: the restricted runtime URL used by web; it must not use the admin or migration
  role.
- `BACKUP_AGE_RECIPIENT`: the public age recipient used for encryption.
- `BACKUP_RETENTION_DAYS`: local retention, default 35 days.
- `BACKUP_RCLONE_REMOTE`: optional remote path; rclone credentials stay in the host config.

`AGE_IDENTITY_FILE` is needed only for the explicitly human-run isolated restore rehearsal. It
points to a host file, is never passed into a container, and must be a regular mode-0600 file owned
by the invoking user. Do not copy the recovery identity onto the application host for routine
backups. Do not render Compose configuration without redacting interpolated values.

Create and verify a backup:

```sh
./docker/backup.sh
```

Both scripts default to `.env`. For an isolated rehearsal, set `HOMING_ENV_FILE` to its persistent
mode-0600 environment file. The scripts read `COMPOSE_PROJECT_NAME` from that file, so scheduled or
later commands retain the same project, volumes, networks, image digests, ports, and credentials.
Backup artifacts default to `backups/<COMPOSE_PROJECT_NAME>/`, retention applies only within that
namespace, and off-host uploads append the same project namespace. Production and rehearsal
therefore cannot overwrite or prune each other's artifacts.

The command streams `pg_dump` through `age`, waits for both producer processes, checks that the
result is a non-empty age v1 envelope, and publishes it only after encryption succeeds. The
temporary directory contains FIFOs and an encrypted partial file, never a plaintext dump. Local
publication is atomic and refuses to overwrite an existing artifact; off-host upload occurs only
afterward.

This proves that PostgreSQL completed a custom-format dump and that `age` produced an encrypted
artifact. Without the offline recovery identity it cannot prove decryption, archive inventory, or
restorability; those are proven by the isolated restore rehearsal below.

Restore verifies the archive before stopping public traffic, replaces the database with web and
Caddy stopped, and runs schema migrations only after the restore succeeds. It does not restart
public services automatically:

```sh
HOMING_ENV_FILE=/opt/homing-ts/.env.rehearsal \
RESTORE_CONFIRM=YES AGE_IDENTITY_FILE=/path/to/offline/identity \
./docker/restore.sh /absolute/path/to/backup.dump.age
```

Restore verifies the encrypted archive inventory before stopping public traffic. It then stops web
and Caddy, drops and recreates the target database, decrypts through a draining FIFO, and waits for
both `age` and `pg_restore`. A reset, decrypt, or restore failure leaves web and Caddy stopped.
PostgreSQL restore runs as one transaction, and migrations happen only after restore success. Even
after success, both web and Caddy remain stopped; run private semantic checks and
`./docker/smoke.sh http://localhost:8081` explicitly before starting public Caddy.

Rehearse restore into an isolated database before cutover. Retain the Django encrypted backup,
database volume, checkout, and image for at least seven days. Rolling traffic back to Django after
the TypeScript app accepts writes loses those new writes; that is a human cutover decision.

Immediately after importing the frozen Django snapshot, validate the redacted migration boundary:

```sh
docker compose --env-file /opt/homing-ts/.env.rehearsal run --rm --no-deps \
  -e MIGRATE_PROJECT_ID=<existing-project-uuid> migrate bun run db:validate-import
```
