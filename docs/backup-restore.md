# Backup and restore

Production backups are PostgreSQL custom dumps encrypted in flight with `age`. Plaintext dumps are
never written to disk. Off-host upload is optional and happens only after encryption.

Required `.env` settings:

- `BACKUP_AGE_RECIPIENT`: the public age recipient used for encryption.
- `BACKUP_RETENTION_DAYS`: local retention, default 35 days.
- `BACKUP_RCLONE_REMOTE`: optional remote path; rclone credentials stay in the host config.

`AGE_IDENTITY_FILE` is needed only for restore. It points to a host file and is never passed into a
container. Do not render Compose configuration without redacting interpolated values.

Create and verify a backup:

```sh
./docker/backup.sh
age --decrypt --identity /path/to/identity /path/to/backup.dump.age | pg_restore --list >/dev/null
```

Restore stops public traffic before replacing the database, runs schema migrations, and restarts
the application only after the restore succeeds:

```sh
RESTORE_CONFIRM=YES AGE_IDENTITY_FILE=/path/to/identity ./docker/restore.sh /absolute/path/to/backup.dump.age
./docker/smoke.sh https://staging.example.test
```

Rehearse restore into an isolated database before cutover. Retain the Django encrypted backup,
database volume, checkout, and image for at least seven days. Rolling traffic back to Django after
the TypeScript app accepts writes loses those new writes; that is a human cutover decision.

Immediately after importing the frozen Django snapshot, validate the redacted migration boundary:

```sh
docker compose --env-file .env run --rm --no-deps \
  -e MIGRATE_PROJECT_ID=<existing-project-uuid> web bun run db:validate-import
```
