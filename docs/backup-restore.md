# Backup and restore

Production backups are PostgreSQL custom dumps encrypted with `age`. Plaintext dumps are never
written to disk; off-host upload occurs only after encryption succeeds. Backups belong to the
TypeScript Compose project and are independent of the agent kit's local SQLite work ledger.

Required environment settings:

- `DATABASE_ADMIN_URL`: initial database-owner URL used only by provisioning and backup/restore;
- `DATABASE_MIGRATION_URL`: URL used only by Drizzle migrations;
- `DATABASE_URL`: restricted runtime URL used by web;
- `BACKUP_AGE_RECIPIENT`: public age recipient;
- `BACKUP_RETENTION_DAYS`: local retention period;
- `BACKUP_RCLONE_REMOTE`: optional remote destination; credentials stay in host configuration.

`AGE_IDENTITY_FILE` is only for a human-run isolated restore rehearsal. It must be a regular,
mode-0600 file owned by the invoking user, is never passed into a container, and is never rendered
or printed. Redact all interpolated configuration output.

## Create and verify

```sh
./docker/backup.sh
```

The command reads the persistent environment file, selects its Compose project namespace, streams
`pg_dump` through `age`, waits for both producer processes, verifies a non-empty age envelope, and
publishes atomically without overwriting an existing artifact. Temporary files contain FIFOs and an
encrypted partial only. Retention and optional upload are scoped to the same project namespace, so
rehearsal and production artifacts cannot prune or overwrite one another.

The routine command proves an encrypted dump was produced. Decryption, archive inventory, and
restorability require the isolated restore rehearsal below.

## Restore rehearsal and recovery

Restore uses an empty isolated target, verifies the encrypted archive before stopping public
traffic, decrypts through a draining FIFO, waits for `age` and `pg_restore`, and runs migrations
only after restore succeeds. A reset, decrypt, or restore failure leaves web and Caddy stopped.
After success, web and Caddy remain stopped until private semantic checks and smoke pass.

```sh
HOMING_ENV_FILE=/opt/homing-ts/.env.rehearsal \
RESTORE_CONFIRM=YES AGE_IDENTITY_FILE=/path/to/offline/identity \
./docker/restore.sh /absolute/path/to/backup.dump.age
```

Rehearse the exact restore before each production release. Record pre-migration counts and
checksums, prove the expanded schema preserves existing data, run old-image and v2-image smoke,
create a fresh encrypted backup, restore it into isolation, and verify v2 constraints and
canonical package bytes. Database restore is reserved for corruption or this explicit recovery
exercise; ordinary release failure rolls back the prior TypeScript image.

The backup job is separate from the local agent schedule. During local v2 removal or server
rollback, preserve and verify the independently named `com.homing.backup` job and its artifacts;
never delete shared application-support or log paths merely because they share a parent directory.
