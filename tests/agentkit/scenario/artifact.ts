import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildAgentKitArtifact } from "../../../src/server/agentkit/package";

export type MaterializedAgentKit = {
  root: string;
  manifest: string;
  install: string;
  selftest: string;
  finalize: string;
};

export async function materializeAgentKit(
  temp: string,
  origin = "https://homing.test",
): Promise<MaterializedAgentKit> {
  const artifact = await buildAgentKitArtifact(origin);
  const root = await mkdtemp(join(temp, "homing-agent-kit-"));
  for (const file of artifact.files.values()) {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes);
  }
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, artifact.manifestBytes);
  await writeFile(join(root, artifact.manifest.archive.path), artifact.archiveBytes);
  return {
    root,
    manifest,
    install: join(root, "scripts", "install.py"),
    selftest: join(root, "scripts", "selftest.py"),
    finalize: join(root, "scripts", "finalize.py"),
  };
}
