import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { buildVirtualEnvironment, type VirtualEnvironment } from "./environment";
import { ResourceLedger } from "./ledger";
import { runChild } from "./process";

export type VirtualPersona = {
  runId: string;
  root: string;
  home: string;
  temp: string;
  toolBin: string;
  codexHome: string;
  xdgConfig: string;
  xdgState: string;
  xdgCache: string;
  downloadFixture: string;
  transcripts: string;
  hostGuard: string;
  targetCanary: string;
  hostCanary: string;
  environment: VirtualEnvironment;
  ledger: ResourceLedger;
};

export async function createVirtualPersona(options: {
  python: string;
  locale?: string;
  timezone?: string;
}): Promise<VirtualPersona> {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "homing-agent-test-"));
  if (
    dirname(await realpath(root)) !== parent ||
    !basename(root).startsWith("homing-agent-test-")
  ) {
    throw new Error(`Unsafe virtual persona root: ${root}`);
  }

  const runId = basename(root).slice("homing-agent-test-".length);
  const paths = {
    home: join(root, "home"),
    temp: join(root, "tmp"),
    toolBin: join(root, "tool-bin"),
    codexHome: join(root, "codex-home"),
    xdgConfig: join(root, "xdg", "config"),
    xdgState: join(root, "xdg", "state"),
    xdgCache: join(root, "xdg", "cache"),
    downloadFixture: join(root, "home", "Downloads", "Homing setup – O'Neil"),
    transcripts: join(root, "transcripts"),
    hostGuard: join(root, "synthetic-host-guard"),
  };
  const ledger = await ResourceLedger.create(join(root, "ledger.json"), root, runId);
  for (const [id, path] of Object.entries(paths)) {
    await ledger.plan({ id, type: "directory", target: path });
    await mkdir(path, { recursive: true, mode: 0o700 });
    await ledger.mark(id, "created");
  }

  const targetCanary = `TARGET-${randomBytes(16).toString("hex")}`;
  const hostCanary = `HOST-${randomBytes(16).toString("hex")}`;
  await writeFile(join(paths.hostGuard, "canary.txt"), hostCanary, { mode: 0o600 });
  await mkdir(join(paths.home, ".agents", "skills"), { recursive: true, mode: 0o700 });

  const environment = buildVirtualEnvironment({
    root,
    ...paths,
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.timezone ? { timezone: options.timezone } : {}),
    declared: {
      HOMING_TEST_TARGET_CANARY: targetCanary,
      HOMING_TEST_PYTHON: resolve(options.python),
    },
  });
  return { runId, root, ...paths, targetCanary, hostCanary, environment, ledger };
}

export async function calibrateVirtualPersona(
  persona: VirtualPersona,
  python: string,
): Promise<{ python: string; architecture: string; locale: string; timezone: string }> {
  const script = [
    "import json,locale,os,platform,tempfile,time",
    "assert os.path.realpath(os.path.expanduser('~')) == os.path.realpath(os.environ['HOME'])",
    "assert os.path.realpath(tempfile.gettempdir()) == os.path.realpath(os.environ['TMPDIR'])",
    "p=os.path.join(os.environ['HOME'], \"Homing setup – O'Neil.txt\")",
    "open(p,'w',encoding='utf-8').write('calibrated')",
    "assert open(p,encoding='utf-8').read() == 'calibrated'",
    "print(json.dumps({'python':platform.python_version(),'architecture':platform.machine(),'locale':locale.setlocale(locale.LC_CTYPE),'timezone':time.tzname[0]}))",
  ].join(";");
  const result = await runChild([python, "-c", script], {
    cwd: persona.home,
    env: persona.environment.values,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Virtual persona calibration failed: ${result.stderr || result.stdout}`);
  }
  const value = JSON.parse(result.stdout.trim()) as {
    python: string;
    architecture: string;
    locale: string;
    timezone: string;
  };
  const [major, minor] = value.python.split(".").map(Number);
  if ((major ?? 0) < 3 || ((major ?? 0) === 3 && (minor ?? 0) < 9)) {
    throw new Error(`Python ${value.python} is below the documented 3.9 floor`);
  }
  return value;
}

export async function destroyVirtualPersona(persona: VirtualPersona): Promise<void> {
  await persona.ledger.cleanupFilesystem();
  await rm(persona.root, { recursive: true, force: true });
}
