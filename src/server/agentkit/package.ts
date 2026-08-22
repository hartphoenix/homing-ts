import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Zippable, zipSync } from "fflate";
import type { Hono } from "hono";

import type { AppVariables } from "../types";

const PACKAGE_NAME = "homing-agent-kit";
const PACKAGE_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../agentkit/package",
);
const BOOTSTRAP_PATH = resolve(PACKAGE_ROOT, "../bootstrap.py");
const ORIGIN_PLACEHOLDER = "__HOMING_ORIGIN__";
const MAX_MEMBER_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024;
const FIXED_ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0);
const CACHE_CONTROL = "public, max-age=3600";

type PackageFile = {
  path: string;
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
  lines: number;
  firstLine: string;
  lastLine: string;
};

export type AgentKitManifest = {
  schema: 1;
  package: typeof PACKAGE_NAME;
  version: number;
  min_runtime_version: 1;
  files: Array<{
    path: string;
    url: string;
    bytes: number;
    lines: number;
    sha256: string;
    first_line: string;
    last_line: string;
  }>;
  archive: {
    path: string;
    url: string;
    bytes: number;
    sha256: string;
  };
};

export type AgentKitArtifact = {
  index: PackageFile;
  bootstrap: PackageFile;
  files: Map<string, PackageFile>;
  manifest: AgentKitManifest;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  archiveBytes: Uint8Array;
  archiveSha256: string;
};

const textEncoder = new TextEncoder();
const artifactCache = new Map<string, Promise<AgentKitArtifact>>();

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function linesOf(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function contentType(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function sourcePaths(directory = PACKAGE_ROOT, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await sourcePaths(resolve(directory, entry.name), relative)));
    } else if (entry.isFile() && relative !== "index.md") {
      paths.push(relative);
    }
  }
  return paths;
}

async function loadTextFile(path: string, publicOrigin: string): Promise<PackageFile> {
  const source = await readFile(resolve(PACKAGE_ROOT, path), "utf8");
  const text = source.replaceAll(ORIGIN_PLACEHOLDER, publicOrigin);
  const bytes = textEncoder.encode(text);
  if (bytes.byteLength > MAX_MEMBER_BYTES) {
    throw new Error(`Agent-kit package member exceeds ${MAX_MEMBER_BYTES} bytes: ${path}`);
  }
  const lines = linesOf(text);
  return {
    path,
    bytes,
    contentType: contentType(path),
    sha256: digest(bytes),
    lines: lines.length,
    firstLine: lines.at(0) ?? "",
    lastLine: lines.at(-1) ?? "",
  };
}

async function loadBootstrap(): Promise<PackageFile> {
  const text = await readFile(BOOTSTRAP_PATH, "utf8");
  const bytes = textEncoder.encode(text);
  return {
    path: "bootstrap.py",
    bytes,
    contentType: "text/x-python; charset=utf-8",
    sha256: digest(bytes),
    lines: linesOf(text).length,
    firstLine: linesOf(text).at(0) ?? "",
    lastLine: linesOf(text).at(-1) ?? "",
  };
}

export async function buildAgentKitArtifact(publicOrigin: string): Promise<AgentKitArtifact> {
  const normalizedOrigin = publicOrigin.replace(/\/$/, "");
  const cached = artifactCache.get(normalizedOrigin);
  if (cached) return cached;

  const artifact = (async () => {
    const versionText = await readFile(resolve(PACKAGE_ROOT, "VERSION"), "utf8");
    const version = Number.parseInt(versionText.trim(), 10);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("Agent-kit VERSION must be one positive integer.");
    }

    const files = new Map<string, PackageFile>();
    const zippable: Zippable = {};
    for (const path of await sourcePaths()) {
      const file = await loadTextFile(path, normalizedOrigin);
      files.set(path, file);
      zippable[path] = [file.bytes, { level: 9, mtime: FIXED_ZIP_TIME }];
    }

    const archiveBytes = zipSync(zippable, { level: 9, mtime: FIXED_ZIP_TIME });
    if (archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error(`Agent-kit archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
    }
    const archiveSha256 = digest(archiveBytes);
    const archivePath = `homing-agent-kit-${version}.zip`;
    const manifest: AgentKitManifest = {
      schema: 1,
      package: PACKAGE_NAME,
      version,
      min_runtime_version: 1,
      files: [...files.values()].map((file) => ({
        path: file.path,
        url: `${normalizedOrigin}/agent/pkg/${file.path}`,
        bytes: file.bytes.byteLength,
        lines: file.lines,
        sha256: file.sha256,
        first_line: file.firstLine,
        last_line: file.lastLine,
      })),
      archive: {
        path: archivePath,
        url: `${normalizedOrigin}/agent/pkg/${archivePath}`,
        bytes: archiveBytes.byteLength,
        sha256: archiveSha256,
      },
    };
    const manifestBytes = textEncoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const index = await loadTextFile("index.md", normalizedOrigin);
    const bootstrap = await loadBootstrap();
    return {
      index,
      bootstrap,
      files,
      manifest,
      manifestBytes,
      manifestSha256: digest(manifestBytes),
      archiveBytes,
      archiveSha256,
    };
  })();
  artifactCache.set(normalizedOrigin, artifact);
  try {
    return await artifact;
  } catch (error) {
    artifactCache.delete(normalizedOrigin);
    throw error;
  }
}

function packageResponse(
  bytes: Uint8Array,
  contentTypeValue: string,
  sha256: string,
  head: boolean,
  ifNoneMatch?: string,
): Response {
  const etag = `"${sha256}"`;
  const matches = ifNoneMatch
    ?.split(",")
    .some((candidate) => candidate.trim() === "*" || candidate.trim().replace(/^W\//, "") === etag);
  if (matches) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": CACHE_CONTROL, ETag: etag },
    });
  }
  return new Response(head ? null : new Uint8Array(bytes).buffer, {
    headers: {
      "Cache-Control": CACHE_CONTROL,
      "Content-Length": String(bytes.byteLength),
      "Content-Type": contentTypeValue,
      ETag: etag,
    },
  });
}

function notFound(): Response {
  return Response.json(
    { error: { code: "not_found", message: "Object not found." } },
    { status: 404 },
  );
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: { code: "method_not_allowed", message: "Method not allowed." } },
    { status: 405, headers: { Allow: "GET, HEAD" } },
  );
}

export function registerAgentKitRoutes(
  app: Hono<{ Variables: AppVariables }>,
  publicOrigin: string,
): void {
  const serve = async (path: string, head: boolean, ifNoneMatch?: string): Promise<Response> => {
    const artifact = await buildAgentKitArtifact(publicOrigin);
    if (path === "/agent" || path === "/agent/") {
      return packageResponse(
        artifact.index.bytes,
        artifact.index.contentType,
        artifact.index.sha256,
        head,
        ifNoneMatch,
      );
    }
    if (path === "/agent/pkg/manifest.json") {
      return packageResponse(
        artifact.manifestBytes,
        "application/json; charset=utf-8",
        artifact.manifestSha256,
        head,
        ifNoneMatch,
      );
    }
    if (path === "/agent/bootstrap.py") {
      return packageResponse(
        artifact.bootstrap.bytes,
        artifact.bootstrap.contentType,
        artifact.bootstrap.sha256,
        head,
        ifNoneMatch,
      );
    }
    if (path === `/agent/pkg/${artifact.manifest.archive.path}`) {
      return packageResponse(
        artifact.archiveBytes,
        "application/zip",
        artifact.archiveSha256,
        head,
        ifNoneMatch,
      );
    }
    const prefix = "/agent/pkg/";
    if (!path.startsWith(prefix)) return notFound();
    const relative = path.slice(prefix.length);
    const file = artifact.files.get(relative);
    if (!file) return notFound();
    return packageResponse(file.bytes, file.contentType, file.sha256, head, ifNoneMatch);
  };

  const legacy = (path: string): Response =>
    new Response(null, {
      status: 301,
      headers: { Location: `${publicOrigin.replace(/\/$/, "")}${path}` },
    });

  app.get("/agent/pkg/SKILL.md", () => legacy("/agent/pkg/SETUP.md"));
  app.on("HEAD", "/agent/pkg/SKILL.md", () => legacy("/agent/pkg/SETUP.md"));
  app.get("/agent-setup/SKILL.md", () => legacy("/agent/pkg/SETUP.md"));
  app.on("HEAD", "/agent-setup/SKILL.md", () => legacy("/agent/pkg/SETUP.md"));
  app.get("/agent", (context) =>
    serve(context.req.path, false, context.req.header("if-none-match")),
  );
  app.on("HEAD", "/agent", (context) =>
    serve(context.req.path, true, context.req.header("if-none-match")),
  );
  app.get("/agent/*", (context) =>
    serve(context.req.path, false, context.req.header("if-none-match")),
  );
  app.on("HEAD", "/agent/*", (context) =>
    serve(context.req.path, true, context.req.header("if-none-match")),
  );
  app.all("/agent", methodNotAllowed);
  app.all("/agent/*", methodNotAllowed);
  app.all("/agent-setup/SKILL.md", methodNotAllowed);
}
