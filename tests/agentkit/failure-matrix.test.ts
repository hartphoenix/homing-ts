import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { expect, it } from "vitest";

import { materializeAgentKit } from "./scenario/artifact";

it("authenticates and safely extracts archives before any package write", async () => {
  const packageArtifact = await materializeAgentKit(tmpdir());
  try {
    const manifest = JSON.parse(await readFile(packageArtifact.manifest, "utf8")) as {
      archive: { path: string };
    };
    const result = spawnSync(
      "python3",
      [
        resolve(import.meta.dirname, "bootstrap-safety.py"),
        resolve(import.meta.dirname, "../../agentkit/bootstrap.py"),
        packageArtifact.manifest,
        resolve(packageArtifact.root, manifest.archive.path),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ status: "PASS", cases: 5 });
  } finally {
    await rm(packageArtifact.root, { recursive: true, force: true });
  }
});

it("rolls back every instrumented fresh-install and repair mutation", async () => {
  const packageArtifact = await materializeAgentKit(tmpdir());
  try {
    const result = spawnSync(
      "python3",
      [resolve(import.meta.dirname, "failure-matrix.py"), packageArtifact.root],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}");
    expect(report).toMatchObject({
      schema: 1,
      status: "PASS",
      scheduler_compensation: "PASS",
      repair_byte_identity: "PASS",
      windows_model_environment: "PASS",
    });
    expect(report.checkpoints.fresh).toBeGreaterThan(40);
    expect(report.checkpoints.repair).toBeGreaterThan(40);
  } finally {
    await rm(packageArtifact.root, { recursive: true, force: true });
  }
});
