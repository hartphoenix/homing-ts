import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type LedgerResource = {
  id: string;
  type: "directory" | "file" | "process-group" | "container" | "image" | "network" | "volume";
  target: string;
  state: "planned" | "created" | "cleaned";
};

type LedgerDocument = {
  schema: 1;
  runId: string;
  root: string;
  resources: LedgerResource[];
};

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation !== "" &&
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

export class ResourceLedger {
  readonly path: string;
  private readonly document: LedgerDocument;

  private constructor(path: string, document: LedgerDocument) {
    this.path = path;
    this.document = document;
  }

  static async create(path: string, root: string, runId: string): Promise<ResourceLedger> {
    if (!isAbsolute(path) || !isAbsolute(root)) throw new Error("Ledger paths must be absolute");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const ledger = new ResourceLedger(path, { schema: 1, runId, root, resources: [] });
    await ledger.persist();
    return ledger;
  }

  static async load(path: string): Promise<ResourceLedger> {
    const parsed = JSON.parse(await readFile(path, "utf8")) as LedgerDocument;
    if (
      parsed.schema !== 1 ||
      !parsed.runId ||
      !isAbsolute(parsed.root) ||
      !Array.isArray(parsed.resources)
    ) {
      throw new Error("Invalid resource ledger");
    }
    return new ResourceLedger(path, parsed);
  }

  get resources(): readonly LedgerResource[] {
    return this.document.resources;
  }

  get runId(): string {
    return this.document.runId;
  }

  get root(): string {
    return this.document.root;
  }

  async plan(resource: Omit<LedgerResource, "state">): Promise<void> {
    if (this.document.resources.some((entry) => entry.id === resource.id)) {
      throw new Error(`Duplicate ledger resource: ${resource.id}`);
    }
    if (
      (resource.type === "directory" || resource.type === "file") &&
      !inside(this.document.root, resolve(resource.target))
    ) {
      throw new Error(`Filesystem resource escapes run root: ${resource.target}`);
    }
    this.document.resources.push({ ...resource, state: "planned" });
    await this.persist();
  }

  async mark(id: string, state: "created" | "cleaned"): Promise<void> {
    const resource = this.document.resources.find((entry) => entry.id === id);
    if (!resource) throw new Error(`Unknown ledger resource: ${id}`);
    resource.state = state;
    await this.persist();
  }

  async cleanupFilesystem(): Promise<void> {
    for (const resource of [...this.document.resources].reverse()) {
      if (resource.state === "cleaned" || !["directory", "file"].includes(resource.type)) continue;
      const target = resolve(resource.target);
      if (!inside(this.document.root, target))
        throw new Error(`Refusing broad cleanup target: ${target}`);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw new Error(`Refusing symlink cleanup boundary: ${target}`);
        if (resource.type === "directory") await chmod(target, 0o700).catch(() => undefined);
        await rm(target, { recursive: resource.type === "directory", force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      resource.state = "cleaned";
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    const temporary = `${this.path}.write-${process.pid}-${Date.now()}`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.document, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    try {
      const parent = await open(dirname(this.path), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } catch {
      // Directory fsync is unavailable on some supported filesystems.
    }
  }
}
