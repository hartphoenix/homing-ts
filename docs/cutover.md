# Cutover and rollback

The Django deployment stays intact at `/opt/homing`; the replacement lives at `/opt/homing-ts`.
Their Compose projects, database volumes, Caddy volumes, and networks are distinct. Only one Caddy
may own public ports 80/443 at a time.

Production deployment, traffic switching, and rollback are human-authorized operations. Agents may
prepare commands and run preapproved staging commands, but do not handle host secrets.

## Private rehearsal

Use a separate database and Caddy state. The published ports remain bound to localhost:

```sh
HOMING_HTTP_PUBLISH=127.0.0.1:8081 \
HOMING_HTTPS_PUBLISH=127.0.0.1:8444 \
HOMING_HTTPS_UDP_PUBLISH=127.0.0.1:8444 \
POSTGRES_VOLUME_NAME=homing-ts-staging-postgres \
CADDY_DATA_VOLUME_NAME=homing-ts-staging-caddy-data \
CADDY_CONFIG_VOLUME_NAME=homing-ts-staging-caddy-config \
EDGE_NETWORK_NAME=homing-ts-staging-edge \
DATABASE_NETWORK_NAME=homing-ts-staging-database \
APP_DOMAIN=http://localhost \
PUBLIC_ORIGIN=http://localhost:8081 \
docker compose --env-file .env up --detach --wait
```

Run migrations, the compact API suite, real unchanged-client checks, migration validation, backup,
isolated restore, and `docker/smoke.sh` before approving cutover. Rehearsal data is disposable and
must not share the production replacement volume.

## Production switch

1. Record the intended release commit and verify public ports, disk space, image availability, and
   both rollback checkouts.
2. Stop Django Caddy and web traffic. Record this freeze timestamp. Keep the Django database up but
   admit no writes.
3. Take the final encrypted Django backup from the frozen database. Verify its encrypted file and
   dump inventory.
4. Initialize the empty replacement database, run Drizzle migrations, and import from the frozen
   Django snapshot. Preserve both user IDs and the project UUID. Run `db:validate-import`.
5. Start the replacement privately and verify both migrated memberships, Hart's login if desired,
   API isolation, the agent kit, a new encrypted backup, and an isolated restore of that backup.
6. Re-pair each installed agent without adding another schedule. Confirm project discovery retains
   the project UUID, replace the token in the secret store, run source-plan repair and one on-demand
   search, then confirm exactly one schedule remains.
7. Rehearse the rollback command from the running replacement. Stop replacement Caddy, then start it
   on public ports. Run smoke checks and core browser journeys.

If any validation before step 7 fails, stop the replacement and restart Django web and Caddy before
admitting writes.

## Rollback

Stop replacement Caddy and web, then start Django web and Caddy against the preserved old database
volume. Keep the old encrypted backup, checkout, image, and named volume for at least seven days.

Writes accepted by the replacement do not exist in Django. If any occurred, rollback deliberately
abandons them unless a separate reconciliation is designed and tested. Hart chooses whether that
data divergence is acceptable before rollback.
