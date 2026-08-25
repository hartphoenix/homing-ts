import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type CommandResult = { code: number; output: string };

const repository = process.cwd();
const backupScript = join(repository, "docker/backup.sh");
const restoreScript = join(repository, "docker/restore.sh");
const preflightScript = join(repository, "docker/preflight.sh");

const fakeDocker = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *pg_dump*)
    if [ "$FAKE_DUMP_STATUS" -ne 0 ]; then exit "$FAKE_DUMP_STATUS"; fi
    printf '%s' 'archive-fixture'
    ;;
  *'pg_restore --list'*)
    if [ "\${FAKE_INVENTORY_EARLY_CLOSE:-0}" -eq 1 ]; then
      dd bs=1024 count=1 >/dev/null 2>&1 || true
    else
      cat >/dev/null
    fi
    exit "$FAKE_INVENTORY_STATUS"
    ;;
  *'pg_restore --host='*)
    cat >/dev/null
    exit "$FAKE_RESTORE_STATUS"
    ;;
  *)
    exit 0
    ;;
esac
`;

const fakeAge = `#!/bin/sh
set -eu
if [ "$1" = "--encrypt" ]; then
  output=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --output) shift; output=$1 ;;
    esac
    shift
  done
  if [ "$FAKE_ENCRYPT_STATUS" -ne 0 ]; then
    cat >/dev/null
    exit "$FAKE_ENCRYPT_STATUS"
  fi
  payload=$(cat)
  if [ "\${FAKE_BAD_ENVELOPE:-0}" -eq 1 ]; then
    printf 'not-an-age-envelope:%s' "$payload" >"$output"
  else
    printf 'age-encryption.org/v1\\n-> test\\n--- test\\n%s' "$payload" >"$output"
  fi
  exit 0
fi

file=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --identity) shift ;;
    *) file=$1 ;;
  esac
  shift
done
if [ "$FAKE_DECRYPT_STATUS" -ne 0 ]; then exit "$FAKE_DECRYPT_STATUS"; fi
tail -n +4 "$file"
`;

function runScript(
  script: string,
  root: string,
  overrides: Record<string, string> = {},
  args: string[] = [],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [script, ...args], {
      cwd: repository,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
        PROJECT_DIR: root,
        BACKUP_DIR: join(root, "backups"),
        FAKE_DOCKER_LOG: join(root, "docker.log"),
        FAKE_DUMP_STATUS: "0",
        FAKE_ENCRYPT_STATUS: "0",
        FAKE_DECRYPT_STATUS: "0",
        FAKE_INVENTORY_STATUS: "0",
        FAKE_INVENTORY_EARLY_CLOSE: "0",
        FAKE_RESTORE_STATUS: "0",
        FAKE_BAD_ENVELOPE: "0",
        RESTORE_CONFIRM: "YES",
        HOMING_ENV_FILE: "",
        COMPOSE_PROJECT_NAME: "",
        COMPOSE_FILE: "",
        HOMING_OPS_LOCK_DIR: "",
        APP_DOMAIN: "",
        PUBLIC_ORIGIN: "",
        HOMING_IMAGE: "",
        POSTGRES_IMAGE: "",
        CADDY_IMAGE: "",
        DATABASE_URL: "",
        DATABASE_ADMIN_URL: "",
        DATABASE_MIGRATION_URL: "",
        AUTH_THROTTLE_KEY: "",
        POSTGRES_DB: "",
        POSTGRES_USER: "",
        POSTGRES_PASSWORD: "",
        POSTGRES_APP_USER: "",
        POSTGRES_APP_PASSWORD: "",
        POSTGRES_MIGRATION_USER: "",
        POSTGRES_MIGRATION_PASSWORD: "",
        BACKUP_AGE_RECIPIENT: "",
        BACKUP_AGE_IDENTITY_FILE: "",
        AGE_IDENTITY_FILE: "",
        BACKUP_RETENTION_DAYS: "",
        HOMING_DEMO_ACCOUNTS: "",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

describe("deployment script failure paths", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "homing-deployment-scripts-"));
    await writeFile(join(root, ".env"), "");
    await writeFile(join(root, "compose.yaml"), "services: {}\n");
    await writeFile(join(root, "identity"), "test-only-identity\n");
    await chmod(join(root, "identity"), 0o600);
    await mkdir(join(root, "bin"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function installMocksAndEnvironment(): Promise<void> {
    await writeFile(join(root, "bin", "docker"), fakeDocker);
    await writeFile(join(root, "bin", "age"), fakeAge);
    await chmod(join(root, "bin", "docker"), 0o755);
    await chmod(join(root, "bin", "age"), 0o755);
    await writeFile(
      join(root, ".env"),
      [
        "POSTGRES_DB=homing",
        "POSTGRES_USER=homing",
        "POSTGRES_PASSWORD=test-password-only",
        "POSTGRES_APP_USER=homing_app",
        "POSTGRES_APP_PASSWORD=test-app-password-only",
        "POSTGRES_MIGRATION_USER=homing_migration",
        "POSTGRES_MIGRATION_PASSWORD=test-migration-password-only",
        "DATABASE_ADMIN_URL=postgresql://homing:test-password-only@db:5432/homing",
        "DATABASE_MIGRATION_URL=postgresql://homing_migration:test-migration-password-only@db:5432/homing",
        "DATABASE_URL=postgresql://homing_app:test-app-password-only@db:5432/homing",
        "PUBLIC_ORIGIN=https://homing.example.test",
        "APP_DOMAIN=homing.example.test",
        `HOMING_IMAGE=registry.example.test/homing@sha256:${"a".repeat(64)}`,
        `POSTGRES_IMAGE=postgres@sha256:${"b".repeat(64)}`,
        `CADDY_IMAGE=caddy@sha256:${"c".repeat(64)}`,
        "AUTH_THROTTLE_KEY=01234567890123456789012345678901",
        "BACKUP_AGE_RECIPIENT=age1testrecipient",
        `BACKUP_AGE_IDENTITY_FILE=${join(root, "identity")}`,
        `AGE_IDENTITY_FILE=${join(root, "identity")}`,
        "HOMING_DEMO_ACCOUNTS=0",
      ].join("\n"),
    );
    await chmod(join(root, ".env"), 0o600);
  }

  it("publishes a verified encrypted backup without a recovery identity", async () => {
    await installMocksAndEnvironment();
    await rm(join(root, "identity"));
    const result = await runScript(backupScript, root);
    expect(result.code).toBe(0);
    const files = await readdir(join(root, "backups"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^homing-ts-.*\.dump\.age$/);
    const backupPath = join(root, "backups", files[0] as string);
    expect(await readFile(backupPath, "utf8")).toContain("age-encryption.org/v1");
    expect((await stat(backupPath)).mode & 0o077).toBe(0);
    const log = await readFile(join(root, "docker.log"), "utf8");
    expect(log).toContain("pg_dump");
    expect(log).not.toContain("pg_restore --list");
  });

  it.each([
    ["pg_dump", { FAKE_DUMP_STATUS: "17" }],
    ["encryption", { FAKE_ENCRYPT_STATUS: "18" }],
    ["age envelope", { FAKE_BAD_ENVELOPE: "1" }],
  ])("does not publish when %s fails", async (_label, overrides) => {
    await installMocksAndEnvironment();
    const result = await runScript(backupScript, root, overrides);
    expect(result.code).not.toBe(0);
    expect(await readdir(join(root, "backups"))).toEqual([]);
    expect(
      (await readdir(join(root, "backups"))).some((file) => file.includes("homing-backup")),
    ).toBe(false);
  });

  it("rejects a corrupt restore before stopping public traffic", async () => {
    await installMocksAndEnvironment();
    const backup = join(root, "corrupt.dump.age");
    await writeFile(backup, "age-encryption.org/v1\n-> test\n--- test\narchive-fixture");
    const result = await runScript(restoreScript, root, { FAKE_INVENTORY_STATUS: "21" }, [backup]);
    expect(result.code).not.toBe(0);
    const log = await readFile(join(root, "docker.log"), "utf8");
    expect(log).not.toContain("stop web caddy");
  });

  it("keeps public traffic stopped when restore itself fails", async () => {
    await installMocksAndEnvironment();
    const backup = join(root, "valid.dump.age");
    await writeFile(backup, "age-encryption.org/v1\n-> test\n--- test\narchive-fixture");
    const result = await runScript(restoreScript, root, { FAKE_RESTORE_STATUS: "22" }, [backup]);
    expect(result.code).not.toBe(0);
    const log = await readFile(join(root, "docker.log"), "utf8");
    expect(log).toContain("stop web caddy");
    expect(log).not.toContain("up --detach --wait web caddy");
  });

  it("drains a large decrypted stream when archive inventory closes early", async () => {
    await installMocksAndEnvironment();
    const backup = join(root, "large.dump.age");
    await writeFile(
      backup,
      `age-encryption.org/v1\n-> test\n--- test\n${"archive-fixture\\n".repeat(1024 * 512)}`,
    );
    const result = await runScript(restoreScript, root, { FAKE_INVENTORY_EARLY_CLOSE: "1" }, [
      backup,
    ]);
    expect(result.code).toBe(0);
    const log = await readFile(join(root, "docker.log"), "utf8");
    expect(log.match(/pg_restore --list/g)).toHaveLength(1);
    expect(log).toContain("dropdb --force --host=127.0.0.1");
    expect(log).toContain("createdb --host=127.0.0.1");
    expect(log).not.toContain("--clean");
    expect(log).toContain("run --rm --no-deps provision");
    expect(log).toContain("run --rm --no-deps migrate");
    expect(log).not.toContain("run --rm --no-deps web bun run db:migrate");
    expect(log).not.toContain("up --detach --wait web caddy");
  });

  it("preflight rejects unsafe production settings without printing values", async () => {
    await installMocksAndEnvironment();
    const secret = "test-password-only";
    const result = await runScript(preflightScript, root, {
      APP_DOMAIN: "http://example.com",
      PUBLIC_ORIGIN: "http://example.com",
      HOMING_DEMO_ACCOUNTS: "1",
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("HOMING_DEMO_ACCOUNTS=1");
    expect(result.output).not.toContain(secret);
  });

  it("preflight accepts a complete HTTPS production configuration", async () => {
    await installMocksAndEnvironment();
    const result = await runScript(preflightScript, root);
    expect(result.code).toBe(0);
    expect(result.output).toContain("production preflight passed");
  });

  it("ships the production preflight as an executable", async () => {
    expect((await stat(preflightScript)).mode & 0o111).not.toBe(0);
  });

  it("keeps Compose resources project-scoped and persists rehearsal selection", async () => {
    const compose = await readFile(join(repository, "compose.yaml"), "utf8");
    const backup = await readFile(backupScript, "utf8");
    const restore = await readFile(restoreScript, "utf8");
    expect(compose).not.toContain("POSTGRES_VOLUME_NAME");
    expect(compose).not.toContain("EDGE_NETWORK_NAME");
    expect(backup).toContain("HOMING_ENV_FILE");
    expect(restore).toContain("HOMING_ENV_FILE");
    expect(backup).toContain('docker compose -f "$compose_file"');
    expect(restore).toContain('docker compose -f "$compose_file"');
    expect(backup).toContain("read_env_value COMPOSE_PROJECT_NAME");
    expect(restore).toContain("read_env_value COMPOSE_PROJECT_NAME");
    expect(backup).toContain("backups/$backup_namespace");
    expect(backup).toContain("$backup_rclone_remote/$backup_namespace/");
    expect(backup).toContain('-name "$backup_namespace-*.dump.age"');
  });

  it("pins backup and restore to PROJECT_DIR/compose.yaml despite ambient COMPOSE_FILE", async () => {
    await installMocksAndEnvironment();
    const backupResult = await runScript(backupScript, root, {
      COMPOSE_FILE: "/wrong/compose.yaml",
    });
    expect(backupResult.code).toBe(0);

    const backup = join(root, "valid.dump.age");
    await writeFile(backup, "age-encryption.org/v1\n-> test\n--- test\narchive-fixture");
    const restoreResult = await runScript(
      restoreScript,
      root,
      { COMPOSE_FILE: "/wrong/compose.yaml" },
      [backup],
    );
    expect(restoreResult.code).toBe(0);

    const log = await readFile(join(root, "docker.log"), "utf8");
    expect(log).toContain(`-f ${join(root, "compose.yaml")}`);
    expect(log).not.toContain("/wrong/compose.yaml");
  });

  it("scopes backup publication and retention by the persisted Compose project", async () => {
    await installMocksAndEnvironment();
    await writeFile(
      join(root, ".env"),
      `${await readFile(join(root, ".env"), "utf8")}\nCOMPOSE_PROJECT_NAME=homing-ts-rehearsal\n`,
    );
    const result = await runScript(backupScript, root, { BACKUP_DIR: "" });
    expect(result.code).toBe(0);
    const scopedDirectory = join(root, "backups", "homing-ts-rehearsal");
    const files = await readdir(scopedDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^homing-ts-rehearsal-.*\.dump\.age$/);
    expect(await readFile(join(root, "docker.log"), "utf8")).toContain("-p homing-ts-rehearsal");
  });

  it.each([
    ["domain mismatch", { APP_DOMAIN: "other.example.test" }],
    [
      "database host mismatch",
      { DATABASE_URL: "postgresql://homing_app:test-app-password-only@localhost:5432/homing" },
    ],
    [
      "database credential mismatch",
      { DATABASE_URL: "postgresql://other:test-app-password-only@db:5432/homing" },
    ],
    ["wrong HTTPS port", { PUBLIC_ORIGIN: "https://homing.example.test:8443" }],
    ["retention shape", { BACKUP_RETENTION_DAYS: "many" }],
    ["retention range", { BACKUP_RETENTION_DAYS: "0" }],
    ["mutable Homing image", { HOMING_IMAGE: "registry.example.test/homing:latest" }],
    ["mutable PostgreSQL image", { POSTGRES_IMAGE: "postgres:17" }],
    ["mutable Caddy image", { CADDY_IMAGE: "caddy:2" }],
  ])("preflight rejects %s without printing secrets", async (_label, overrides) => {
    await installMocksAndEnvironment();
    const result = await runScript(preflightScript, root, overrides);
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain("test-password-only");
  });
});
