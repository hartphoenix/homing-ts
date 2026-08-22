import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeAgentKit } from "../agentkit/scenario/artifact";
import { agentKitInstallPlan } from "../agentkit/scenario/plan";

const temporaryPaths: string[] = [];

function python(script: string, ...args: string[]) {
  return spawnSync("python3", [script, ...args], { encoding: "utf8" });
}

function publishedV2Revision(): string {
  const repository = join(import.meta.dirname, "../..");
  const history = spawnSync("git", ["log", "--format=%H", "--", "agentkit/package/VERSION"], {
    cwd: repository,
    encoding: "utf8",
  });
  if (history.status !== 0) throw new Error(history.stderr);
  for (const revision of history.stdout.trim().split(/\s+/)) {
    const version = spawnSync("git", ["show", `${revision}:agentkit/package/VERSION`], {
      cwd: repository,
      encoding: "utf8",
    });
    if (version.status !== 0 || version.stdout.trim() !== "2") continue;
    const skill = spawnSync("git", ["cat-file", "-e", `${revision}:agentkit/package/SKILL.md`], {
      cwd: repository,
    });
    if (skill.status === 0) return revision;
  }
  throw new Error("Published v2 setup skill is absent from repository history");
}

async function materializePublishedV2(target: string): Promise<string> {
  const repository = join(import.meta.dirname, "../..");
  const revision = publishedV2Revision();
  const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", revision, "agentkit/package"], {
    cwd: repository,
    encoding: "utf8",
  });
  if (tree.status !== 0) throw new Error(tree.stderr);
  let skill = "";
  for (const source of tree.stdout.trim().split(/\r?\n/)) {
    const relative = source.slice("agentkit/package/".length);
    const blob = spawnSync("git", ["show", `${revision}:${source}`], { cwd: repository });
    if (blob.status !== 0) throw new Error(blob.stderr.toString());
    const destination = join(target, relative);
    await mkdir(dirname(destination), { recursive: true });
    const served = blob.stdout
      .toString("utf8")
      .replaceAll("__HOMING_ORIGIN__", "https://homing.test");
    await writeFile(destination, served);
    if (relative === "SKILL.md") skill = served;
  }
  return skill;
}

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeDirectoriesWritable(path: string): Promise<void> {
  try {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeDirectoriesWritable(join(path, entry.name));
    }
  } catch {
    // A lifecycle test may have already removed its guarded temporary root.
  }
}

afterEach(async () => {
  await Promise.all(temporaryPaths.map(makeDirectoriesWritable));
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("agent-kit lifecycle", () => {
  it("installs a scheduler-only worker without persistent setup or skill content", async () => {
    const root = await temporary("homing-install-test-");
    const agentKit = await materializeAgentKit(tmpdir());
    temporaryPaths.push(agentKit.root);
    expect(
      python(
        agentKit.finalize,
        "--init",
        "--package-root",
        agentKit.root,
        "--manifest",
        agentKit.manifest,
      ).status,
    ).toBe(0);
    const planPath = join(root, "plan.json");
    await writeJson(planPath, agentKitInstallPlan(root, false));

    const installed = python(
      agentKit.install,
      "--config",
      planPath,
      "--setup-workspace",
      agentKit.root,
    );
    expect(installed.status, installed.stderr).toBe(0);

    const manifestPath = join(root, "state", "install-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.runtime_prompt).toBe(join(root, "config", "prompts", "JUDGE.md"));
    expect(manifest.interactive_skill).toMatchObject({ enabled: false, dir: "", copies: [] });
    expect(manifest.paths.skill).toBe("");
    await expect(stat(join(root, "config", "prompts", "JUDGE.md"))).resolves.toBeTruthy();
    await expect(stat(join(root, "config", "connect.sh"))).rejects.toThrow();
    await expect(stat(join(agentKit.root, "connect.sh"))).resolves.toBeTruthy();
    await expect(stat(join(root, "skills", "homing-check"))).rejects.toThrow();
    const runner = await readFile(join(root, "config", "bin", "run.sh"), "utf8");
    expect(runner).toContain(join(root, "config", "prompts", "JUDGE.md"));
    expect(runner).not.toMatch(/SETUP\.md|finalize\.py|probe\.sh|homing-setup/);

    const checked = python(
      agentKit.selftest,
      "--manifest",
      manifestPath,
      "--offline",
      "--no-secret-read",
      "--json",
    );
    expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
    const report = JSON.parse(checked.stdout);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "runtime-frontmatter", status: "PASS" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "no-reprobe", status: "PASS" }),
    );

    const canonicalManifestText = await readFile(manifestPath, "utf8");
    const copiedManifest = join(root, "copied-install-manifest.json");
    const substituted = JSON.parse(canonicalManifestText);
    substituted.files.push({
      path: join(root, "config", "foreign-user-file.txt"),
      mode: "0o600",
      sha256: "0".repeat(64),
    });
    await writeJson(copiedManifest, substituted);
    const substitutedRemoval = python(
      agentKit.install,
      "--uninstall",
      "--manifest",
      copiedManifest,
      "--purge-logs",
    );
    expect(substitutedRemoval.status).not.toBe(0);
    await expect(stat(join(root, "config", "bin", "run.sh"))).resolves.toBeTruthy();

    const foreignFile = join(root, "config", "foreign-user-file.txt");
    await writeFile(foreignFile, "foreign\n");
    await writeJson(manifestPath, substituted);
    const canonicalTamper = python(
      agentKit.install,
      "--uninstall",
      "--manifest",
      manifestPath,
      "--purge-logs",
    );
    expect(canonicalTamper.status).not.toBe(0);
    await expect(readFile(foreignFile, "utf8")).resolves.toBe("foreign\n");
    await writeFile(manifestPath, canonicalManifestText);

    const finalized = python(
      agentKit.finalize,
      "--finalize",
      "--package-root",
      agentKit.root,
      "--manifest",
      agentKit.manifest,
      "--installed-manifest",
      manifestPath,
    );
    expect(finalized.status, finalized.stderr).toBe(0);
    await expect(stat(agentKit.root)).rejects.toThrow();
    const daily = spawnSync("/bin/sh", [join(root, "config", "bin", "run.sh"), "--help"], {
      encoding: "utf8",
    });
    expect(daily.status, daily.stderr).toBe(0);

    const repairKit = await materializeAgentKit(tmpdir());
    temporaryPaths.push(repairKit.root);
    expect(
      python(
        repairKit.finalize,
        "--init",
        "--package-root",
        repairKit.root,
        "--manifest",
        repairKit.manifest,
      ).status,
    ).toBe(0);
    const repaired = python(
      repairKit.install,
      "--repair",
      "--manifest",
      manifestPath,
      "--setup-workspace",
      repairKit.root,
      "--dry-run",
    );
    expect(repaired.status, repaired.stderr).toBe(0);
    const repairedReal = python(
      repairKit.install,
      "--repair",
      "--manifest",
      manifestPath,
      "--setup-workspace",
      repairKit.root,
    );
    expect(repairedReal.status, repairedReal.stderr).toBe(0);
    const repairedCheck = python(
      repairKit.selftest,
      "--manifest",
      manifestPath,
      "--offline",
      "--no-secret-read",
      "--json",
    );
    expect(repairedCheck.status, repairedCheck.stderr).toBe(0);
    const repairFinalized = python(
      repairKit.finalize,
      "--finalize",
      "--package-root",
      repairKit.root,
      "--manifest",
      repairKit.manifest,
      "--installed-manifest",
      manifestPath,
    );
    expect(repairFinalized.status, repairFinalized.stderr).toBe(0);
    await expect(stat(repairKit.root)).rejects.toThrow();
  });

  it("keeps the optional daily skill separate from the scheduled worker prompt", async () => {
    const root = await temporary("homing-install-test-");
    const agentKit = await materializeAgentKit(tmpdir());
    temporaryPaths.push(agentKit.root);
    expect(
      python(
        agentKit.finalize,
        "--init",
        "--package-root",
        agentKit.root,
        "--manifest",
        agentKit.manifest,
      ).status,
    ).toBe(0);
    const planPath = join(root, "plan.json");
    await writeJson(planPath, agentKitInstallPlan(root, true));

    const installed = python(
      agentKit.install,
      "--config",
      planPath,
      "--setup-workspace",
      agentKit.root,
    );
    expect(installed.status, installed.stderr).toBe(0);
    const skill = await readFile(join(root, "skills", "homing-check", "SKILL.md"), "utf8");
    expect(skill).toContain("name: homing-check");
    expect(skill).not.toContain("disable-model-invocation");
    expect(skill).not.toMatch(/SETUP\.md|finalize\.py|install\.py|probe\.sh|homing-setup/);
    await expect(stat(join(root, "skills", "homing-check", "JUDGE.md"))).rejects.toThrow();
    await expect(stat(join(root, "config", "prompts", "JUDGE.md"))).resolves.toBeTruthy();

    const legacySetup = join(root, "skills", "homing-setup");
    await mkdir(legacySetup);
    await writeFile(join(legacySetup, "SKILL.md"), "# Legacy setup residue\n");
    const checked = python(
      agentKit.selftest,
      "--manifest",
      join(root, "state", "install-manifest.json"),
      "--offline",
      "--no-secret-read",
      "--json",
    );
    expect(checked.status).toBe(1);
    const report = JSON.parse(checked.stdout);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "no-reprobe",
        status: "FAIL",
        details: expect.arrayContaining([
          expect.stringContaining("ephemeral in every supported agent environment"),
        ]),
      }),
    );
  });

  it("removes verified legacy setup residue but preserves lookalikes", async () => {
    const root = await temporary("homing-install-test-");
    const agentKit = await materializeAgentKit(tmpdir());
    temporaryPaths.push(agentKit.root);
    expect(
      python(
        agentKit.finalize,
        "--init",
        "--package-root",
        agentKit.root,
        "--manifest",
        agentKit.manifest,
      ).status,
    ).toBe(0);
    const planPath = join(root, "plan.json");
    await writeJson(planPath, agentKitInstallPlan(root, false));
    const portableLegacy = join(root, "home", ".agents", "skills", "homing-setup");
    const publishedV2 = await materializePublishedV2(portableLegacy);
    const lookalike = join(root, "home", ".claude", "skills", "homing-setup");
    await mkdir(lookalike, { recursive: true });
    await writeFile(join(lookalike, "SKILL.md"), `${publishedV2}\nmodified\n`);
    const foreignTarget = join(root, "foreign-legacy-target");
    await mkdir(foreignTarget);
    await writeFile(
      join(foreignTarget, "SKILL.md"),
      "---\nname: homing-setup\n---\n# Homing setup procedure\n",
    );
    const linkedRoot = join(root, "home", ".config", "claude", "skills");
    await mkdir(linkedRoot, { recursive: true });
    const linkedLegacy = join(linkedRoot, "homing-setup");
    await symlink(foreignTarget, linkedLegacy);

    const installed = python(
      agentKit.install,
      "--config",
      planPath,
      "--setup-workspace",
      agentKit.root,
    );
    expect(installed.status, installed.stderr).toBe(74);
    await expect(stat(portableLegacy)).rejects.toThrow();
    await expect(stat(join(lookalike, "SKILL.md"))).resolves.toBeTruthy();
    expect((await lstat(linkedLegacy)).isSymbolicLink()).toBe(true);
    await expect(stat(join(foreignTarget, "SKILL.md"))).resolves.toBeTruthy();
    await expect(stat(join(root, "home", ".config", "homing"))).rejects.toThrow();
  });

  it("refuses completion when an agent skill root cannot be inspected", async () => {
    const root = await temporary("homing-install-test-");
    const agentKit = await materializeAgentKit(tmpdir());
    temporaryPaths.push(agentKit.root);
    expect(
      python(
        agentKit.finalize,
        "--init",
        "--package-root",
        agentKit.root,
        "--manifest",
        agentKit.manifest,
      ).status,
    ).toBe(0);
    const planPath = join(root, "plan.json");
    await writeJson(planPath, agentKitInstallPlan(root, false));
    const denied = join(root, "home", ".config", "claude", "skills");
    await mkdir(join(denied, "homing-setup"), { recursive: true });
    await writeFile(join(denied, "homing-setup", "SKILL.md"), "unreadable setup\n");
    await chmod(denied, 0o000);
    try {
      const installed = python(
        agentKit.install,
        "--config",
        planPath,
        "--setup-workspace",
        agentKit.root,
      );
      expect(installed.status, installed.stderr).toBe(74);
      expect(installed.stdout).toContain("cannot inspect skill root");
      await expect(stat(join(root, "home", ".config", "homing"))).rejects.toThrow();
    } finally {
      await chmod(denied, 0o700);
    }
  });

  it("refuses install-time protected roots and symlink aliases before mutation", async () => {
    for (const kind of ["home", "setup", "cwd", "alias"] as const) {
      const root = await temporary(`homing-protected-${kind}-`);
      const agentKit = await materializeAgentKit(tmpdir());
      temporaryPaths.push(agentKit.root);
      expect(
        python(
          agentKit.finalize,
          "--init",
          "--package-root",
          agentKit.root,
          "--manifest",
          agentKit.manifest,
        ).status,
      ).toBe(0);
      const plan = agentKitInstallPlan(root, false);
      await mkdir(plan.home, { recursive: true });
      let processCwd = plan.home;
      let protectedTarget = plan.home;
      let canaryPath = join(protectedTarget, "protected-canary");
      if (kind === "setup") {
        protectedTarget = agentKit.root;
        canaryPath = join(agentKit.root, "SETUP.md");
      }
      if (kind === "cwd") {
        processCwd = join(root, "working-directory");
        protectedTarget = processCwd;
        await mkdir(processCwd);
      }
      if (kind === "alias") {
        const actual = join(root, "foreign-target");
        const alias = join(root, "linked-parent");
        await mkdir(actual);
        await symlink(actual, alias);
        protectedTarget = join(alias, "homing");
        canaryPath = join(actual, "canary");
        await writeFile(canaryPath, "foreign\n");
      } else if (kind !== "setup") {
        canaryPath = join(protectedTarget, "protected-canary");
        await writeFile(canaryPath, "foreign\n");
      }
      plan.paths.config = protectedTarget;
      const planPath = join(root, `plan-${kind}.json`);
      await writeJson(planPath, plan);
      const installed = spawnSync(
        "python3",
        [agentKit.install, "--config", planPath, "--setup-workspace", agentKit.root],
        { cwd: processCwd, encoding: "utf8" },
      );
      expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(74);
      expect(`${installed.stdout}\n${installed.stderr}`).toMatch(
        /protected root|crosses a symlink/,
      );
      if (kind === "alias") {
        await expect(stat(canaryPath)).resolves.toBeTruthy();
        await expect(stat(join(root, "foreign-target", "homing"))).rejects.toThrow();
      } else {
        await expect(stat(canaryPath)).resolves.toBeTruthy();
      }
    }
  });

  it("finalizes only a verified temporary package with a durable worker", async () => {
    const agentKit = await materializeAgentKit(tmpdir());
    temporaryPaths.push(agentKit.root);
    const packageRoot = agentKit.root;
    const manifestPath = agentKit.manifest;
    const finalizer = agentKit.finalize;

    const refused = python(
      finalizer,
      "--discard",
      "--package-root",
      tmpdir(),
      "--manifest",
      manifestPath,
    );
    expect(refused.status).toBe(73);
    expect(refused.stderr).toContain("direct child");

    const initialized = python(
      finalizer,
      "--init",
      "--package-root",
      packageRoot,
      "--manifest",
      manifestPath,
    );
    expect(initialized.status, initialized.stderr).toBe(0);

    const durableRoot = await temporary("homing-durable-");
    const runner = join(durableRoot, "run.sh");
    const fabricatedManifest = join(durableRoot, "install-manifest.json");
    await writeFile(runner, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
    await writeJson(fabricatedManifest, { package_version: 3, runner });
    const fabricated = python(
      finalizer,
      "--finalize",
      "--package-root",
      packageRoot,
      "--manifest",
      manifestPath,
      "--installed-manifest",
      fabricatedManifest,
    );
    expect(fabricated.status).toBe(73);
    await unlink(runner);
    await unlink(fabricatedManifest);

    const planPath = join(durableRoot, "plan.json");
    await writeJson(planPath, agentKitInstallPlan(durableRoot, false));
    const installed = python(
      agentKit.install,
      "--config",
      planPath,
      "--setup-workspace",
      packageRoot,
    );
    expect(installed.status, installed.stderr).toBe(0);
    const installedManifest = join(durableRoot, "state", "install-manifest.json");

    const dryRun = python(
      finalizer,
      "--finalize",
      "--package-root",
      packageRoot,
      "--manifest",
      manifestPath,
      "--installed-manifest",
      installedManifest,
      "--dry-run",
    );
    expect(dryRun.status, dryRun.stderr).toBe(0);
    await expect(stat(packageRoot)).resolves.toBeTruthy();

    const finalized = python(
      finalizer,
      "--finalize",
      "--package-root",
      packageRoot,
      "--manifest",
      manifestPath,
      "--installed-manifest",
      installedManifest,
    );
    expect(finalized.status, finalized.stderr).toBe(0);
    await expect(stat(packageRoot)).rejects.toThrow();
  });

  it("refuses changed members, archive tampering, and symlinked package members", async () => {
    const changed = await materializeAgentKit(tmpdir());
    temporaryPaths.push(changed.root);
    expect(
      python(
        changed.finalize,
        "--init",
        "--package-root",
        changed.root,
        "--manifest",
        changed.manifest,
      ).status,
    ).toBe(0);
    await writeFile(join(changed.root, "SETUP.md"), "changed after verification\n");
    const changedRefusal = python(
      changed.finalize,
      "--discard",
      "--package-root",
      changed.root,
      "--manifest",
      changed.manifest,
    );
    expect(changedRefusal.status).toBe(73);
    expect(changedRefusal.stderr).toMatch(/wrong (size|digest)/);
    await expect(stat(changed.root)).resolves.toBeTruthy();

    const archive = await materializeAgentKit(tmpdir());
    temporaryPaths.push(archive.root);
    expect(
      python(
        archive.finalize,
        "--init",
        "--package-root",
        archive.root,
        "--manifest",
        archive.manifest,
      ).status,
    ).toBe(0);
    const publicManifest = JSON.parse(await readFile(archive.manifest, "utf8"));
    await writeFile(join(archive.root, publicManifest.archive.path), "changed archive\n");
    const archiveRefusal = python(
      archive.finalize,
      "--discard",
      "--package-root",
      archive.root,
      "--manifest",
      archive.manifest,
    );
    expect(archiveRefusal.status).toBe(73);
    expect(archiveRefusal.stderr).toContain("downloaded archive has the wrong size");

    const linked = await materializeAgentKit(tmpdir());
    temporaryPaths.push(linked.root);
    const foreign = join(await temporary("homing-package-foreign-"), "SETUP.md");
    await writeFile(foreign, "foreign setup\n");
    await unlink(join(linked.root, "SETUP.md"));
    await symlink(foreign, join(linked.root, "SETUP.md"));
    const linkedRefusal = python(
      linked.finalize,
      "--init",
      "--package-root",
      linked.root,
      "--manifest",
      linked.manifest,
    );
    expect(linkedRefusal.status).toBe(73);
    expect(linkedRefusal.stderr).toContain("not a regular file");
    await expect(readFile(foreign, "utf8")).resolves.toBe("foreign setup\n");

    const hardLinked = await materializeAgentKit(tmpdir());
    temporaryPaths.push(hardLinked.root);
    const hardLinkSource = join(await temporary("homing-package-hardlink-"), "SETUP.md");
    await writeFile(hardLinkSource, await readFile(join(hardLinked.root, "SETUP.md")));
    await unlink(join(hardLinked.root, "SETUP.md"));
    await link(hardLinkSource, join(hardLinked.root, "SETUP.md"));
    const hardLinkRefusal = python(
      hardLinked.finalize,
      "--init",
      "--package-root",
      hardLinked.root,
      "--manifest",
      hardLinked.manifest,
    );
    expect(hardLinkRefusal.status).toBe(73);
    expect(hardLinkRefusal.stderr).toContain("not a regular file");
  });

  it("refuses broad manifests and uninstalls only owned files", async () => {
    const root = await temporary("homing-install-test-");
    const agentKit = await materializeAgentKit(tmpdir());
    temporaryPaths.push(agentKit.root);
    expect(
      python(
        agentKit.finalize,
        "--init",
        "--package-root",
        agentKit.root,
        "--manifest",
        agentKit.manifest,
      ).status,
    ).toBe(0);
    const planPath = join(root, "plan.json");
    await writeJson(planPath, agentKitInstallPlan(root, true));
    const installed = python(
      agentKit.install,
      "--config",
      planPath,
      "--setup-workspace",
      agentKit.root,
    );
    expect(installed.status, installed.stderr).toBe(0);
    const manifestPath = join(root, "state", "install-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    const tamperedPath = join(root, "tampered-manifest.json");
    const tampered = structuredClone(manifest);
    const configOwnership = tampered.owned_dirs.find(
      (entry: { role: string }) => entry.role === "config",
    );
    configOwnership.path = root;
    configOwnership.marker = join(root, ".homing-install-owner.json");
    await writeJson(tamperedPath, tampered);
    const refused = python(agentKit.install, "--uninstall", "--manifest", tamperedPath);
    expect(refused.status).not.toBe(0);
    await expect(stat(join(root, "config", "bin", "run.sh"))).resolves.toBeTruthy();

    for (const path of [
      join(root, "config"),
      join(root, "state"),
      join(root, "skills", "homing-check"),
    ]) {
      await writeFile(join(path, "foreign.txt"), "not owned by Homing\n");
    }
    const removed = python(
      agentKit.install,
      "--uninstall",
      "--manifest",
      manifestPath,
      "--purge-logs",
    );
    expect(removed.status, `${removed.stdout}\n${removed.stderr}`).toBe(0);
    for (const path of [
      join(root, "config"),
      join(root, "state"),
      join(root, "skills", "homing-check"),
    ]) {
      await expect(readFile(join(path, "foreign.txt"), "utf8")).resolves.toBe(
        "not owned by Homing\n",
      );
      await expect(stat(join(path, ".homing-install-owner.json"))).rejects.toThrow();
    }
    await expect(stat(join(root, "config", "bin", "run.sh"))).rejects.toThrow();
    const discarded = python(
      agentKit.finalize,
      "--discard",
      "--package-root",
      agentKit.root,
      "--manifest",
      agentKit.manifest,
    );
    expect(discarded.status, discarded.stderr).toBe(0);
  });

  it("refuses package substitution, unowned collisions, symlink swaps, and hard-link swaps", async () => {
    const packageA = await materializeAgentKit(tmpdir());
    const packageB = await materializeAgentKit(tmpdir());
    temporaryPaths.push(packageA.root, packageB.root);
    for (const artifact of [packageA, packageB]) {
      expect(
        python(
          artifact.finalize,
          "--init",
          "--package-root",
          artifact.root,
          "--manifest",
          artifact.manifest,
        ).status,
      ).toBe(0);
    }

    const substitutedRoot = await temporary("homing-substitution-test-");
    const substitutedPlan = join(substitutedRoot, "plan.json");
    await writeJson(substitutedPlan, agentKitInstallPlan(substitutedRoot, false));
    const substituted = python(
      packageA.install,
      "--config",
      substitutedPlan,
      "--setup-workspace",
      packageB.root,
    );
    expect(substituted.status).toBe(73);
    expect(substituted.stderr).toContain("does not match this package");
    await expect(stat(join(substitutedRoot, "state"))).rejects.toThrow();

    const collisionRoot = await temporary("homing-collision-test-");
    await mkdir(join(collisionRoot, "config"));
    await writeFile(join(collisionRoot, "config", "foreign.txt"), "foreign\n");
    const collisionPlan = join(collisionRoot, "plan.json");
    await writeJson(collisionPlan, agentKitInstallPlan(collisionRoot, false));
    const collision = python(
      packageA.install,
      "--config",
      collisionPlan,
      "--setup-workspace",
      packageA.root,
    );
    expect(collision.status).toBe(74);
    expect(collision.stderr).toContain("already exists");
    await expect(readFile(join(collisionRoot, "config", "foreign.txt"), "utf8")).resolves.toBe(
      "foreign\n",
    );
    await expect(stat(join(collisionRoot, "state"))).rejects.toThrow();

    for (const replacement of ["symlink", "hardlink"] as const) {
      const root = await temporary(`homing-${replacement}-test-`);
      const artifact = await materializeAgentKit(tmpdir());
      temporaryPaths.push(artifact.root);
      expect(
        python(
          artifact.finalize,
          "--init",
          "--package-root",
          artifact.root,
          "--manifest",
          artifact.manifest,
        ).status,
      ).toBe(0);
      const planPath = join(root, "plan.json");
      await writeJson(planPath, agentKitInstallPlan(root, false));
      const installed = python(
        artifact.install,
        "--config",
        planPath,
        "--setup-workspace",
        artifact.root,
      );
      expect(installed.status, installed.stderr).toBe(0);

      const foreign = join(root, `foreign-${replacement}.txt`);
      await writeFile(foreign, `foreign-${replacement}\n`);
      const owned = join(root, "config", "config.json");
      await unlink(owned);
      if (replacement === "symlink") await symlink(foreign, owned);
      else await link(foreign, owned);

      const removed = python(
        artifact.install,
        "--uninstall",
        "--manifest",
        join(root, "state", "install-manifest.json"),
        "--purge-logs",
      );
      expect(removed.status).toBe(74);
      expect(removed.stdout).toContain(
        `owned file ${
          replacement === "symlink" ? "was replaced with another type" : "has another hard link"
        }`,
      );
      await expect(readFile(foreign, "utf8")).resolves.toBe(`foreign-${replacement}\n`);
    }
  });
});
