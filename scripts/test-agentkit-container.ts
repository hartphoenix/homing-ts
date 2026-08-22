#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { ResourceLedger } from "../tests/agent-harness/ledger";
import { materializeAgentKit } from "../tests/agentkit/scenario/artifact";

const projectRoot = resolve(import.meta.dir, "..");
const harnessLabel = "homing.agentkit.harness=virtual-user-v1";
const runPrefix = "homing-agentkit-container-";
const keep = process.argv.includes("--keep");
const dockerHostArgument = process.argv.find((value) => value.startsWith("--docker-host="));
const explicitDockerHost = dockerHostArgument?.slice("--docker-host=".length);
if (explicitDockerHost) {
  if (!explicitDockerHost.startsWith("unix://") || !isAbsolute(explicitDockerHost.slice(7))) {
    throw new Error("--docker-host must name one absolute unix:// socket");
  }
}

type Persona = {
  id: "python39" | "python-current";
  baseByArchitecture: Record<"amd64" | "arm64", string>;
};

const personas: Persona[] = [
  {
    id: "python39",
    baseByArchitecture: {
      amd64:
        "python:3.9-slim-bookworm@sha256:03dee9ce00747bb5390e7b4ad00307b4dbc7790f7da77cc3581f93cfa99a6363",
      arm64:
        "python:3.9-slim-bookworm@sha256:37bef657e63aacf134065c4cb4eacdd335a696cb674401d5269d11245a8ac22b",
    },
  },
  {
    id: "python-current",
    baseByArchitecture: {
      amd64:
        "python:3.14-slim-bookworm@sha256:ff4ceef5258b9303b40c004af0bd31ac82c6248a6b951f9d9b329bf456f1f4b7",
      arm64:
        "python:3.14-slim-bookworm@sha256:a110e01da17f27ebb99b4ae5d8fab540071fcf7bc906b2c8df29c925bb5d9e36",
    },
  },
];

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunNames = {
  runId: string;
  fixtureContainer: string;
  fixtureImage: string;
  network: string;
  targetContainers: string[];
  targetImages: string[];
};

type RecoveryRecord = {
  schema: 1;
  harness: "virtual-user-v1";
  runId: string;
  pid: number;
  keep: boolean;
};

const activeCommands = new Set<{ kill: (signal?: number | NodeJS.Signals) => void }>();

function executable(name: string): string | undefined {
  return Bun.which(name) ?? undefined;
}

function controllerEnvironment(root: string, dockerConfig: string): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: join(root, "controller-home"),
    TMPDIR: join(root, "controller-tmp"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    PATH: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
    DOCKER_CONFIG: dockerConfig,
  };
  if (explicitDockerHost) environment.DOCKER_HOST = explicitDockerHost;
  return environment;
}

async function command(
  argv: string[],
  options: {
    cwd?: string;
    env: Record<string, string>;
    timeoutMs?: number;
    allowFailure?: boolean;
  },
): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  activeCommands.add(child);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? 120_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => {
    clearTimeout(timeout);
    activeCommands.delete(child);
  });
  const result = { exitCode, stdout, stderr };
  if ((exitCode !== 0 || timedOut) && !options.allowFailure) {
    const detail = `${stdout}\n${stderr}`.trim().slice(-4000);
    throw new Error(
      `${basename(argv[0] ?? "command")} ${argv.slice(1, 3).join(" ")} ${
        timedOut ? "timed out" : `failed with ${exitCode}`
      }${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

function namesFor(runId: string): RunNames {
  return {
    runId,
    fixtureContainer: `homing-agentkit-fixture-${runId}`,
    fixtureImage: `homing-agentkit-fixture-image-${runId}`,
    network: `homing-agentkit-network-${runId}`,
    targetContainers: personas.map((persona) => `homing-agentkit-${persona.id}-${runId}`),
    targetImages: personas.map((persona) => `homing-agentkit-${persona.id}-image-${runId}`),
  };
}

async function fsyncedJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeDockerResources(
  docker: string,
  env: Record<string, string>,
  names: RunNames,
  ledger: ResourceLedger,
): Promise<string[]> {
  const failures: string[] = [];
  const expected = new Map(ledger.resources.map((resource) => [resource.target, resource]));
  const remove = async (type: "container" | "network" | "image", target: string): Promise<void> => {
    const resource = expected.get(target);
    if (!resource || resource.type !== type || resource.state === "cleaned") return;
    const format = type === "network" ? "{{json .Labels}}" : "{{json .Config.Labels}}";
    const inspected = await command([docker, type, "inspect", "--format", format, target], {
      env,
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (inspected.exitCode !== 0) {
      if (/No such|not found|does not exist/i.test(inspected.stderr)) {
        await ledger.mark(resource.id, "cleaned");
        return;
      }
      failures.push(`${type} ${target}: could not inspect labels`);
      return;
    }
    let labels: Record<string, string>;
    try {
      labels = JSON.parse(inspected.stdout.trim()) as Record<string, string>;
    } catch {
      failures.push(`${type} ${target}: invalid label record`);
      return;
    }
    if (
      labels["homing.agentkit.harness"] !== "virtual-user-v1" ||
      labels["homing.agentkit.run"] !== names.runId
    ) {
      failures.push(`${type} ${target}: labels do not authorize cleanup`);
      return;
    }
    const argv = type === "network" ? ["network", "rm", target] : [type, "rm", "--force", target];
    const result = await command([docker, ...argv], { env, allowFailure: true, timeoutMs: 30_000 });
    if (result.exitCode !== 0 && !/No such|not found|does not exist/i.test(result.stderr)) {
      failures.push(`${type} ${target}: ${result.stderr.trim().slice(-500)}`);
      return;
    }
    const after = await command([docker, type, "inspect", target], {
      env,
      allowFailure: true,
      timeoutMs: 30_000,
    });
    if (after.exitCode === 0) {
      failures.push(`${type} ${target}: resource still exists after cleanup`);
      return;
    }
    await ledger.mark(resource.id, "cleaned");
  };
  for (const container of [...names.targetContainers, names.fixtureContainer]) {
    await remove("container", container);
  }
  await remove("network", names.network);
  for (const image of [...names.targetImages, names.fixtureImage]) {
    await remove("image", image);
  }
  return failures;
}

async function recoverInterruptedRuns(docker: string, env: Record<string, string>): Promise<void> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(runPrefix)) continue;
    const root = join(tmpdir(), entry.name);
    try {
      const record = JSON.parse(await readFile(join(root, "run.json"), "utf8")) as RecoveryRecord;
      if (
        record.schema !== 1 ||
        record.harness !== "virtual-user-v1" ||
        !/^[a-f0-9]{12}$/.test(record.runId) ||
        !Number.isSafeInteger(record.pid) ||
        typeof record.keep !== "boolean"
      ) {
        continue;
      }
      if (record.keep) continue;
      if (processExists(record.pid)) continue;
      const ledger = await ResourceLedger.load(join(root, "ledger.json"));
      const names = namesFor(record.runId);
      const expectedTargets = new Set([
        names.fixtureContainer,
        names.fixtureImage,
        names.network,
        ...names.targetContainers,
        ...names.targetImages,
      ]);
      const externalResources = ledger.resources.filter((resource) =>
        ["container", "network", "image"].includes(resource.type),
      );
      if (
        ledger.runId !== record.runId ||
        resolve(ledger.root) !== resolve(root) ||
        externalResources.length !== expectedTargets.size ||
        externalResources.some((resource) => !expectedTargets.has(resource.target))
      ) {
        continue;
      }
      const failures = await removeDockerResources(docker, env, names, ledger);
      if (failures.length === 0) await rm(root, { recursive: true, force: true });
    } catch {
      // Unknown temp directories are foreign. Never infer cleanup targets from their names.
    }
  }
}

async function createCertificates(
  openssl: string,
  root: string,
  env: Record<string, string>,
): Promise<{ ca: string; serverCertificate: string; serverKey: string }> {
  const certs = join(root, "certificate-authority");
  await mkdir(certs, { recursive: true, mode: 0o700 });
  const caKey = join(certs, "ca-key.pem");
  const ca = join(certs, "ca.pem");
  const serverKey = join(certs, "server-key.pem");
  const serverRequest = join(certs, "server.csr");
  const serverCertificate = join(certs, "server-cert.pem");
  const extensions = join(certs, "server.ext");
  await writeFile(
    extensions,
    "subjectAltName=DNS:homing.test,DNS:source.test\n" +
      "basicConstraints=critical,CA:FALSE\n" +
      "keyUsage=critical,digitalSignature,keyEncipherment\n" +
      "extendedKeyUsage=serverAuth\n",
    { mode: 0o600 },
  );
  await command(
    [
      openssl,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      ca,
      "-subj",
      "/CN=Homing Agent-Kit Fixture CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-addext",
      "subjectKeyIdentifier=hash",
      "-days",
      "2",
    ],
    { env },
  );
  await command(
    [
      openssl,
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      serverKey,
      "-out",
      serverRequest,
      "-subj",
      "/CN=homing.test",
    ],
    { env },
  );
  await command(
    [
      openssl,
      "x509",
      "-req",
      "-in",
      serverRequest,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      serverCertificate,
      "-days",
      "2",
      "-sha256",
      "-extfile",
      extensions,
    ],
    { env },
  );
  await chmod(caKey, 0o600);
  await chmod(serverKey, 0o600);
  return { ca, serverCertificate, serverKey };
}

async function copyContexts(
  root: string,
  certificates: Awaited<ReturnType<typeof createCertificates>>,
): Promise<{ fixture: string; target: string }> {
  const fixture = join(root, "fixture-context");
  const target = join(root, "target-context");
  const artifactArea = join(root, "artifact");
  await Promise.all([
    mkdir(fixture, { recursive: true, mode: 0o700 }),
    mkdir(target, { recursive: true, mode: 0o700 }),
    mkdir(artifactArea, { recursive: true, mode: 0o700 }),
  ]);
  const artifact = await materializeAgentKit(artifactArea, "https://homing.test:8443");
  await Promise.all([
    copyFile(
      join(projectRoot, "tests/agentkit/fixture-server/Dockerfile"),
      join(fixture, "Dockerfile"),
    ),
    copyFile(
      join(projectRoot, "tests/agentkit/fixture-server/server.py"),
      join(fixture, "server.py"),
    ),
    copyFile(certificates.serverCertificate, join(fixture, "server-cert.pem")),
    copyFile(certificates.serverKey, join(fixture, "server-key.pem")),
    copyFile(
      join(projectRoot, "tests/agentkit/virtual-user/Dockerfile"),
      join(target, "Dockerfile"),
    ),
    copyFile(join(projectRoot, "tests/agentkit/virtual-user/run.py"), join(target, "run.py")),
    copyFile(
      join(projectRoot, "tests/agentkit/virtual-user/entrypoint.sh"),
      join(target, "entrypoint.sh"),
    ),
    copyFile(
      join(projectRoot, "tests/agentkit/failure-matrix.py"),
      join(target, "failure-matrix.py"),
    ),
    copyFile(
      join(projectRoot, "tests/agentkit/virtual-user/fake-model.py"),
      join(target, "fake-model.py"),
    ),
    copyFile(certificates.ca, join(target, "fixture-ca.pem")),
    cp(artifact.root, join(target, "package"), { recursive: true, verbatimSymlinks: true }),
  ]);
  return { fixture, target };
}

function dockerArchitecture(value: string): "amd64" | "arm64" {
  const normalized = value.trim().toLowerCase();
  if (["amd64", "x86_64"].includes(normalized)) return "amd64";
  if (["arm64", "aarch64"].includes(normalized)) return "arm64";
  throw new Error(`Unsupported Docker architecture: ${value}`);
}

async function waitForFixture(
  docker: string,
  env: Record<string, string>,
  container: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await command(
      [
        docker,
        "exec",
        container,
        "python3",
        "-c",
        "import socket; s=socket.create_connection(('127.0.0.1',8443),1); s.close()",
      ],
      { env, allowFailure: true, timeoutMs: 3_000 },
    );
    if (probe.exitCode === 0) return;
    await Bun.sleep(100);
  }
  throw new Error("Fixture HTTPS service did not become ready");
}

function parseScenarioResult(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const line = lines.at(-1);
  if (!line) throw new Error("Contained scenario produced no result");
  const result = JSON.parse(line) as Record<string, unknown>;
  const cases = Array.isArray(result.cases) ? (result.cases as Array<Record<string, unknown>>) : [];
  const calibrationIsValid = cases.every((entry) => {
    const calibration = entry.calibration as Record<string, unknown> | undefined;
    return (
      calibration?.tls === "PASS" &&
      calibration.uid === 10001 &&
      typeof calibration.python === "string" &&
      calibration.python.startsWith("3.") &&
      calibration.locale === "C.UTF-8" &&
      calibration.timezone === "UTC"
    );
  });
  const matrix = result.failure_matrix as Record<string, unknown> | undefined;
  const checkpoints = matrix?.checkpoints as Record<string, unknown> | undefined;
  if (
    result.schema !== 1 ||
    result.tier !== "C" ||
    result.product !== "PASS" ||
    result.product_residue !== "PASS" ||
    result.setup_source_access !== "REFUSED_BY_UID_BOUNDARY" ||
    cases.length !== 2 ||
    !calibrationIsValid ||
    !cases.some((entry) => entry.install_skill === true && typeof entry.calibration === "object") ||
    !cases.some(
      (entry) => entry.install_skill === false && typeof entry.calibration === "object",
    ) ||
    matrix?.status !== "PASS" ||
    checkpoints?.fresh !== 77 ||
    checkpoints?.repair !== 72
  ) {
    throw new Error(`Contained scenario reported an invalid result: ${line.slice(0, 1000)}`);
  }
  return result;
}

async function labelledResourceIds(
  docker: string,
  env: Record<string, string>,
  runId: string,
): Promise<string[]> {
  const runFilter = `label=homing.agentkit.run=${runId}`;
  const queries = [
    [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=${harnessLabel}`,
      "--filter",
      runFilter,
    ],
    ["network", "ls", "--quiet", "--filter", `label=${harnessLabel}`, "--filter", runFilter],
    ["image", "ls", "--quiet", "--filter", `label=${harnessLabel}`, "--filter", runFilter],
  ];
  const ids: string[] = [];
  for (const query of queries) {
    const result = await command([docker, ...query], { env, timeoutMs: 30_000 });
    ids.push(...result.stdout.split(/\s+/).filter(Boolean));
  }
  return [...new Set(ids)].sort();
}

async function main(): Promise<void> {
  const started = performance.now();
  if (keep && process.env.CI) throw new Error("--keep is forbidden in CI");
  const docker = executable("docker");
  const openssl = executable("openssl");
  if (!docker || !openssl) {
    const missing = [!docker && "docker", !openssl && "openssl"].filter(Boolean).join(", ");
    if (process.env.CI) throw new Error(`Tier C dependency unavailable: ${missing}`);
    console.log(
      JSON.stringify({
        schema: 1,
        tier: "C",
        status: "SKIP",
        unmet_claim: "contained nontechnical-user lifecycle",
        missing_resource: missing,
      }),
    );
    return;
  }
  const socketPath = explicitDockerHost?.slice(7) ?? "/var/run/docker.sock";
  if (process.platform !== "win32" && !existsSync(socketPath)) {
    if (process.env.CI) throw new Error("Tier C requires the default Docker daemon socket");
    console.log(
      JSON.stringify({
        schema: 1,
        tier: "C",
        status: "SKIP",
        unmet_claim: "contained nontechnical-user lifecycle",
        missing_resource: "running Docker-compatible engine at the isolated default socket",
      }),
    );
    return;
  }

  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const root = join(tmpdir(), `${runPrefix}${runId}`);
  const dockerConfig = join(root, "docker-client");
  await Promise.all([
    mkdir(join(root, "controller-home"), { recursive: true, mode: 0o700 }),
    mkdir(join(root, "controller-tmp"), { recursive: true, mode: 0o700 }),
    mkdir(dockerConfig, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(dockerConfig, "config.json"), "{}\n", { mode: 0o600 });
  const env = controllerEnvironment(root, dockerConfig);
  const names = namesFor(runId);
  const hostCanary = `HOST-${randomUUID()}`;
  const targetCanary = `TARGET-${randomUUID()}`;
  const hostGuard = join(root, "synthetic-host-guard.txt");
  const runLabel = `homing.agentkit.run=${runId}`;
  await fsyncedJson(join(root, "run.json"), {
    schema: 1,
    harness: "virtual-user-v1",
    runId,
    pid: process.pid,
    keep,
  } satisfies RecoveryRecord);
  const ledger = await ResourceLedger.create(join(root, "ledger.json"), root, runId);
  await ledger.plan({ id: "host-guard", type: "file", target: hostGuard });
  await writeFile(hostGuard, hostCanary, { mode: 0o600 });
  await ledger.mark("host-guard", "created");
  for (const [id, type, target] of [
    ["fixture-container", "container", names.fixtureContainer],
    ["network", "network", names.network],
    ["fixture-image", "image", names.fixtureImage],
    ...names.targetContainers.map((target, index) => [
      `target-container-${index}`,
      "container",
      target,
    ]),
    ...names.targetImages.map((target, index) => [`target-image-${index}`, "image", target]),
  ] as const) {
    await ledger.plan({ id, type, target });
  }
  const git = executable("git");
  const commitResult = git
    ? await command([git, "rev-parse", "HEAD"], {
        cwd: projectRoot,
        env,
        allowFailure: true,
        timeoutMs: 10_000,
      })
    : undefined;
  const dirtyResult = git
    ? await command([git, "status", "--porcelain"], {
        cwd: projectRoot,
        env,
        allowFailure: true,
        timeoutMs: 10_000,
      })
    : undefined;
  const gitCommit = commitResult?.exitCode === 0 ? commitResult.stdout.trim() : "";
  const gitDirty = dirtyResult?.exitCode === 0 ? dirtyResult.stdout.trim().length > 0 : true;

  let cleanupFailures: string[] = [];
  const results: Record<string, unknown>[] = [];
  let daemonAvailable = false;
  let dockerArch = "";
  let fixtureCaSha256 = "";
  let fixtureTranscriptSha256 = "";
  let boundaryAudit = false;
  let cleanupPromise: Promise<string[]> | undefined;
  const cleanupRun = (): Promise<string[]> => {
    cleanupPromise ??= (async () => {
      if (keep) {
        console.error(`Tier C resources retained by explicit --keep: ${root}`);
        return [];
      }
      const failures = daemonAvailable
        ? await removeDockerResources(docker, env, names, ledger)
        : [];
      if (failures.length === 0 && daemonAvailable) {
        const residue = await labelledResourceIds(docker, env, runId).catch((error) => [
          String(error),
        ]);
        if (residue.length > 0) failures.push(`labelled Docker residue: ${residue.join(", ")}`);
      }
      if (failures.length === 0) await rm(root, { recursive: true, force: true });
      return failures;
    })();
    return cleanupPromise;
  };
  const stopAfterCleanup = (exitCode: number): void => {
    for (const child of activeCommands) child.kill("SIGTERM");
    void Bun.sleep(100)
      .then(cleanupRun)
      .then((failures) => {
        if (failures.length > 0) {
          console.error(`Tier C interrupt cleanup failed:\n${failures.join("\n")}`);
          process.exit(74);
        }
        process.exit(exitCode);
      })
      .catch((error) => {
        console.error(`Tier C interrupt cleanup crashed: ${String(error)}`);
        process.exit(74);
      });
  };
  const onInterrupt = (): void => stopAfterCleanup(130);
  const onTerminate = (): void => stopAfterCleanup(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    const info = await command([docker, "info", "--format", "{{.Architecture}}"], {
      env,
      allowFailure: true,
      timeoutMs: 20_000,
    });
    if (info.exitCode !== 0) {
      if (process.env.CI) throw new Error(`Docker daemon unavailable: ${info.stderr.trim()}`);
      console.log(
        JSON.stringify({
          schema: 1,
          tier: "C",
          status: "SKIP",
          unmet_claim: "contained nontechnical-user lifecycle",
          missing_resource: "running Docker-compatible container engine",
        }),
      );
      return;
    }

    daemonAvailable = true;
    await recoverInterruptedRuns(docker, env);
    const architecture = dockerArchitecture(info.stdout);
    dockerArch = architecture;
    const certificates = await createCertificates(openssl, root, env);
    fixtureCaSha256 = createHash("sha256")
      .update(await readFile(certificates.ca))
      .digest("hex");
    const contexts = await copyContexts(root, certificates);
    const fixtureBase = personas[1].baseByArchitecture[architecture];

    await command(
      [
        docker,
        "build",
        "--pull=false",
        "--label",
        harnessLabel,
        "--label",
        runLabel,
        "--build-arg",
        `BASE_IMAGE=${fixtureBase}`,
        "--tag",
        names.fixtureImage,
        contexts.fixture,
      ],
      { env, timeoutMs: 300_000 },
    );
    await ledger.mark("fixture-image", "created");
    await command(
      [
        docker,
        "network",
        "create",
        "--internal",
        "--label",
        harnessLabel,
        "--label",
        runLabel,
        names.network,
      ],
      { env },
    );
    await ledger.mark("network", "created");
    await command(
      [
        docker,
        "run",
        "--detach",
        "--name",
        names.fixtureContainer,
        "--label",
        harnessLabel,
        "--label",
        runLabel,
        "--network",
        names.network,
        "--network-alias",
        "homing.test",
        "--network-alias",
        "source.test",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        "--cpus",
        "0.5",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=16m",
        names.fixtureImage,
      ],
      { env },
    );
    await ledger.mark("fixture-container", "created");
    await waitForFixture(docker, env, names.fixtureContainer);

    for (const [index, persona] of personas.entries()) {
      const base = persona.baseByArchitecture[architecture];
      const targetImage = names.targetImages[index];
      const targetContainer = names.targetContainers[index];
      if (!targetImage || !targetContainer) throw new Error("Persona resource name missing");
      await command(
        [
          docker,
          "build",
          "--pull=false",
          "--label",
          harnessLabel,
          "--label",
          runLabel,
          "--build-arg",
          `BASE_IMAGE=${base}`,
          "--tag",
          targetImage,
          contexts.target,
        ],
        { env, timeoutMs: 300_000 },
      );
      await ledger.mark(`target-image-${index}`, "created");
      await command(
        [
          docker,
          "create",
          "--name",
          targetContainer,
          "--label",
          harnessLabel,
          "--label",
          runLabel,
          "--network",
          names.network,
          "--env",
          `HOMING_HARNESS_HOST_CANARY=${hostCanary}`,
          "--env",
          `HOMING_HARNESS_TARGET_CANARY=${targetCanary}`,
          "--read-only",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "DAC_OVERRIDE",
          "--cap-add",
          "SETUID",
          "--cap-add",
          "SETGID",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "128",
          "--memory",
          "384m",
          "--cpus",
          "1",
          "--ulimit",
          "nofile=256:256",
          "--tmpfs",
          "/home/homing:rw,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=0700",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=1777",
          targetImage,
        ],
        { env, timeoutMs: 30_000 },
      );
      await ledger.mark(`target-container-${index}`, "created");
      const run = await command([docker, "start", "--attach", targetContainer], {
        env,
        timeoutMs: 180_000,
        allowFailure: true,
      });
      if (run.exitCode !== 0) {
        const fixtureDebug = await command(
          [docker, "exec", names.fixtureContainer, "cat", "/tmp/fixture-state.json"],
          { env, allowFailure: true, timeoutMs: 10_000 },
        );
        throw new Error(
          `Contained persona ${persona.id} failed with ${run.exitCode}:\n${run.stderr.slice(-3000)}\n` +
            `fixture=${fixtureDebug.stdout.slice(-2000)}`,
        );
      }
      if (run.stdout.includes(hostCanary) || run.stderr.includes(hostCanary)) {
        throw new Error("Host canary leaked through target output");
      }
      results.push({
        ...parseScenarioResult(run.stdout),
        runtime_persona: persona.id,
        base_image: base,
      });
    }
    const fixtureStateResult = await command(
      [docker, "exec", names.fixtureContainer, "cat", "/tmp/fixture-state.json"],
      { env, timeoutMs: 30_000 },
    );
    const fixtureState = JSON.parse(fixtureStateResult.stdout) as {
      cycles?: number;
      violations?: unknown[];
      requests?: number;
    };
    if (
      fixtureState.cycles !== personas.length * 6 ||
      !Array.isArray(fixtureState.violations) ||
      fixtureState.violations.length !== 0 ||
      !Number.isSafeInteger(fixtureState.requests) ||
      (fixtureState.requests ?? 0) > 300
    ) {
      throw new Error(
        `Fixture state-machine audit failed: ${fixtureStateResult.stdout.slice(0, 1000)}`,
      );
    }
    const fixtureTranscript = await command(
      [docker, "exec", names.fixtureContainer, "cat", "/tmp/fixture-transcript.jsonl"],
      { env, timeoutMs: 30_000 },
    );
    if (fixtureTranscript.stdout.length > 512 * 1024) {
      throw new Error("Fixture transcript exceeded its capture bound");
    }
    fixtureTranscriptSha256 = createHash("sha256").update(fixtureTranscript.stdout).digest("hex");
    const guardAfter = await readFile(hostGuard, "utf8");
    if (guardAfter !== hostCanary || guardAfter.includes(targetCanary)) {
      throw new Error("Synthetic host guard changed during contained execution");
    }
    boundaryAudit = true;
  } finally {
    cleanupFailures = await cleanupRun();
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`Tier C cleanup failed:\n${cleanupFailures.join("\n")}`);
  }
  if (!keep && daemonAvailable) {
    const secondPass = await removeDockerResources(docker, env, names, ledger);
    if (secondPass.length > 0) {
      throw new Error(`Tier C second cleanup pass was not a no-op:\n${secondPass.join("\n")}`);
    }
  }
  if (!keep) {
    try {
      await stat(root);
      throw new Error(`Tier C run root remains: ${root}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  console.log(
    JSON.stringify({
      schema: 1,
      run_id: runId,
      tier: "C",
      status: "PASS",
      product: "PASS",
      harness_version: 1,
      scenario_version: 1,
      git_commit: gitCommit,
      dirty: gitDirty,
      architecture: dockerArch,
      containment:
        "read-only Linux container; trusted root supervisor; capability-free UID 10001 product children",
      network: "internal fixture only",
      fixture_ca_sha256: fixtureCaSha256,
      fixture_transcript_sha256: fixtureTranscriptSha256,
      docker_client_config: "empty disposable config",
      cleanup: keep ? "SKIP (--keep)" : "PASS",
      calibration: "PASS",
      product_residue: results.every((result) => result.product_residue === "PASS")
        ? "PASS"
        : "FAIL",
      harness_cleanup: keep ? "SKIP" : "PASS",
      boundary_audit: boundaryAudit && !keep ? "PASS" : "SKIP",
      host_canary_sha256: createHash("sha256").update(hostCanary).digest("hex"),
      target_canary_sha256: createHash("sha256").update(targetCanary).digest("hex"),
      cleanup_provenance: keep ? [] : ["product", "harness compensation"],
      claims: {
        core_tier_c: "PASS",
        real_agent_conformance: "UNEXECUTED_TIER_D",
        native_scheduler_and_store: "UNEXECUTED_TIER_E",
        expansion_rows: {
          probe_environment_errors: "UNEXECUTED",
          pairing_helper_errors: "UNEXECUTED",
          selftest_failure: "UNEXECUTED",
          daily_protocol_errors: "UNEXECUTED",
          finalize_deletion_denial: "UNEXECUTED",
          controller_term: "UNEXECUTED",
          graceful_cancel: "UNEXECUTED",
          target_term: "UNEXECUTED",
          target_kill_or_host_crash: "UNEXECUTED",
        },
      },
      duration_ms: Math.round(performance.now() - started),
      personas: results,
    }),
  );
}

await main();
