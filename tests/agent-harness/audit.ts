import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type SnapshotEntry = {
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtimeMs: number;
  linkTarget?: string;
  sha256?: string;
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function assertContainedPath(root: string, candidate: string): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(candidate))
    throw new Error("Containment paths must be absolute");
  const rootReal = await realpath(root);
  const parent = resolve(candidate);
  const relation = relative(rootReal, parent);
  if (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  ) {
    return;
  }
  throw new Error(`Path escapes run root: ${candidate}`);
}

export async function snapshotTree(root: string): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];

  async function visit(path: string, relativePath: string): Promise<void> {
    const info = await lstat(path);
    const common = {
      path: relativePath || ".",
      mode: info.mode & 0o7777,
      uid: info.uid,
      gid: info.gid,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
    if (info.isSymbolicLink()) {
      const { readlink } = await import("node:fs/promises");
      entries.push({ ...common, type: "symlink", linkTarget: await readlink(path) });
      return;
    }
    if (info.isDirectory()) {
      entries.push({ ...common, type: "directory" });
      for (const name of (await readdir(path)).sort()) {
        await visit(resolve(path, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    if (info.isFile()) {
      entries.push({ ...common, type: "file", sha256: digest(await readFile(path)) });
      return;
    }
    entries.push({ ...common, type: "other" });
  }

  try {
    await visit(root, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return entries;
}

export function snapshotDigest(snapshot: SnapshotEntry[]): string {
  return digest(Buffer.from(JSON.stringify(snapshot)));
}

export function findLeakedValues(texts: string[], sentinels: string[]): string[] {
  const leaks = new Set<string>();
  for (const sentinel of sentinels) {
    if (!sentinel) continue;
    if (texts.some((text) => text.includes(sentinel))) leaks.add(digest(Buffer.from(sentinel)));
  }
  return [...leaks].sort();
}
