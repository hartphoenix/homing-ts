import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findLeakedValues, snapshotDigest, snapshotTree } from "./audit";
import { ResourceLedger } from "./ledger";
import {
  calibrateVirtualPersona,
  createVirtualPersona,
  destroyVirtualPersona,
  type VirtualPersona,
} from "./persona";
import { runChild } from "./process";

const personas: VirtualPersona[] = [];
const discoveredPython = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
  encoding: "utf8",
});
const python =
  process.env.HOMING_TEST_PYTHON ??
  (discoveredPython.status === 0 ? discoveredPython.stdout.trim() : "python3");

afterEach(async () => {
  await Promise.all(personas.splice(0).map((persona) => destroyVirtualPersona(persona)));
});

describe("generic agent harness", () => {
  it("calibrates an isolated, realistic child environment without inheriting credentials", async () => {
    const persona = await createVirtualPersona({ python, locale: "C.UTF-8", timezone: "UTC" });
    personas.push(persona);

    const calibration = await calibrateVirtualPersona(persona, python);
    expect(calibration.python).toMatch(/^3\./);
    expect(persona.environment.allowedNames).toContain("CODEX_HOME");
    expect(persona.environment.allowedNames).not.toContain("GH_TOKEN");
    expect(persona.environment.values.HOME).toBe(persona.home);
    expect(persona.environment.values.PATH).not.toContain("node_modules");
  });

  it("detects planted host mutation and value leakage", async () => {
    const persona = await createVirtualPersona({ python });
    personas.push(persona);
    const before = snapshotDigest(await snapshotTree(persona.hostGuard));
    await writeFile(join(persona.hostGuard, "mutation.txt"), persona.targetCanary);
    const after = snapshotDigest(await snapshotTree(persona.hostGuard));

    expect(after).not.toBe(before);
    expect(findLeakedValues([`output:${persona.hostCanary}`], [persona.hostCanary])).toHaveLength(
      1,
    );
  });

  it("refuses ledger escapes and symlink cleanup boundaries", async () => {
    const persona = await createVirtualPersona({ python });
    personas.push(persona);
    await expect(
      persona.ledger.plan({
        id: "escape",
        type: "file",
        target: join(persona.root, "..", "escape"),
      }),
    ).rejects.toThrow("escapes run root");

    const link = join(persona.root, "symlink-boundary");
    await persona.ledger.plan({ id: "symlink-boundary", type: "directory", target: link });
    await symlink(persona.home, link);
    await persona.ledger.mark("symlink-boundary", "created");
    await expect(persona.ledger.cleanupFilesystem()).rejects.toThrow("symlink cleanup boundary");
    await rm(link);
    await persona.ledger.mark("symlink-boundary", "cleaned");
  });

  it("terminates a timed-out POSIX process group, including a TERM-ignoring descendant", async () => {
    if (process.platform === "win32") return;
    const persona = await createVirtualPersona({ python });
    personas.push(persona);
    const script = join(persona.root, "hang.sh");
    const descendant = join(persona.root, "descendant.pid");
    await writeFile(
      script,
      `#!/bin/sh
trap 'exit 0' TERM
${python} -c 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)' &
echo $! > '${descendant}'
wait
`,
      { mode: 0o700 },
    );
    const result = await runChild(["/bin/sh", script], {
      cwd: persona.home,
      env: persona.environment.values,
      timeoutMs: 100,
      killGraceMs: 100,
    });
    expect(result.timedOut).toBe(true);
    const descendantPid = Number.parseInt((await readFile(descendant, "utf8")).trim(), 10);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("persists a write-ahead resource before creation", async () => {
    const persona = await createVirtualPersona({ python });
    personas.push(persona);
    const target = join(persona.root, "later");
    const ledger = await ResourceLedger.load(persona.ledger.path);
    await ledger.plan({ id: "later", type: "directory", target });
    expect(ledger.resources.find((entry) => entry.id === "later")?.state).toBe("planned");
    await mkdir(target);
    await ledger.mark("later", "created");
    await ledger.cleanupFilesystem();
    expect(ledger.resources.find((entry) => entry.id === "later")?.state).toBe("cleaned");
  });

  it("rejects a false calibration instead of emitting a product result", async () => {
    if (process.platform === "win32") return;
    const persona = await createVirtualPersona({ python });
    personas.push(persona);
    const falseRuntime = join(persona.toolBin, "false-python");
    await writeFile(
      falseRuntime,
      '#!/bin/sh\necho \'{"python":"3.8.0","architecture":"fixture","locale":"C","timezone":"UTC"}\'\n',
      { mode: 0o700 },
    );
    await expect(calibrateVirtualPersona(persona, falseRuntime)).rejects.toThrow(
      "below the documented 3.9 floor",
    );
  });

  it("records product residue before exact harness cleanup and makes cleanup idempotent", async () => {
    const persona = await createVirtualPersona({ python });
    personas.push(persona);
    const residue = join(persona.home, ".config", "homing", "install-manifest.json");
    await mkdir(join(persona.home, ".config", "homing"), { recursive: true });
    await writeFile(residue, "planted product residue\n");
    const productAudit = await snapshotTree(persona.home);
    expect(productAudit.some((entry) => entry.path.endsWith("install-manifest.json"))).toBe(true);

    await persona.ledger.cleanupFilesystem();
    await persona.ledger.cleanupFilesystem();
    expect(persona.ledger.resources.every((entry) => entry.state === "cleaned")).toBe(true);
  });

  it("loads an intact ledger after repeated atomic persistence", async () => {
    const persona = await createVirtualPersona({ python });
    personas.push(persona);
    for (let index = 0; index < 20; index += 1) {
      await persona.ledger.plan({
        id: `recovery-${index}`,
        type: "file",
        target: join(persona.root, `recovery-${index}.txt`),
      });
    }
    const recovered = await ResourceLedger.load(persona.ledger.path);
    expect(recovered.runId).toBe(persona.runId);
    expect(recovered.resources.filter((entry) => entry.id.startsWith("recovery-"))).toHaveLength(
      20,
    );
  });
});
