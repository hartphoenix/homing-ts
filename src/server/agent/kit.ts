import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Zippable, zipSync } from "fflate";
import { Hono } from "hono";

import { methodNotAllowed, notFound } from "./errors";

export const KIT_PACKAGE = "homing-agent-kit";
export const KIT_ORIGIN_PLACEHOLDER = "__HOMING_ORIGIN__";
export const KIT_MAX_FILE_BYTES = 256 * 1024;
export const KIT_MAX_ARCHIVE_BYTES = 256 * 1024;
export const KIT_CACHE_SECONDS = 300;
export const KIT_VERSION_CACHE_SECONDS = 3600;

const PACKAGE_ROOT = fileURLToPath(new URL("../../../agentkit/package/", import.meta.url));
// fflate serializes DOS fields with local getters. Constructing local midnight keeps
// the archive at the ZIP epoch in every deployment timezone.
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);

export type KitFile = {
  path: string;
  bytes: Uint8Array;
};

export type KitManifestEntry = {
  path: string;
  bytes: number;
  lines: number;
  sha256: string;
  first_line: string;
  last_line: string;
};

export type KitPackage = {
  origin: string;
  version: number;
  files: ReadonlyMap<string, Uint8Array>;
  manifest: {
    package: string;
    version: number;
    generated_for_origin: string;
    min_runtime_version: string;
    files: KitManifestEntry[];
    archive: { path: string; url: string; bytes: number; sha256: string };
  };
  manifestBytes: Uint8Array;
  archiveName: string;
  archiveBytes: Uint8Array;
};

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function lines(value: Uint8Array): { count: number; first: string; last: string } {
  const text = new TextDecoder().decode(value);
  const rows = text.split(/\r\n|\n|\r/);
  if (rows.length > 1 && rows.at(-1) === "") rows.pop();
  return {
    count: text.length === 0 ? 0 : rows.length,
    first: rows[0] ?? "",
    last: rows.at(-1) ?? "",
  };
}

function cleanOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("The configured public origin is not a URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The configured public origin must use HTTP(S)");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("The configured public origin must contain only an origin");
  }
  return parsed.origin;
}

function walk(root: string, current = root): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) names.push(...walk(root, path));
    else if (entry.isFile()) {
      const rel = relative(root, path).split(sep).join("/");
      if (statSync(path).size > KIT_MAX_FILE_BYTES)
        throw new Error(`kit file exceeds size limit: ${rel}`);
      names.push(rel);
    }
  }
  return names.sort();
}

export function isRoutableKitPath(path: string): boolean {
  if (path === "VERSION" || path === "SKILL.md") return true;
  const parts = path.split("/");
  if (parts.length !== 2 || !parts[1]) return false;
  if (parts[0] === "references") return parts[1].endsWith(".md") && parts[1].length > 3;
  return parts[0] === "scripts";
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return (
      trimmed === "*" || (trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed) === etag
    );
  });
}

function contentType(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".zip")) return "application/zip";
  return "text/plain; charset=utf-8";
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

export function buildKitPackage(originInput: string, packageRoot = PACKAGE_ROOT): KitPackage {
  const origin = cleanOrigin(originInput);
  const relpaths = walk(packageRoot);
  const files = new Map<string, Uint8Array>();
  for (const path of relpaths) {
    const source = new TextDecoder().decode(readFileSync(join(packageRoot, path)));
    files.set(path, new TextEncoder().encode(source.replaceAll(KIT_ORIGIN_PLACEHOLDER, origin)));
  }
  const versionBytes = files.get("VERSION");
  if (!versionBytes) throw new Error("agentkit/package/VERSION is missing");
  const versionText = new TextDecoder().decode(versionBytes).trim();
  if (!/^[1-9][0-9]*$/.test(versionText))
    throw new Error("agentkit/package/VERSION must be a positive integer");
  const version = Number(versionText);
  if (!Number.isSafeInteger(version)) throw new Error("agentkit/package/VERSION is too large");

  const members = [...files.keys()].filter((path) => path !== "index.md").sort();
  const manifestFiles = members.map((path) => {
    const bytes = files.get(path) as Uint8Array;
    const shape = lines(bytes);
    return {
      path,
      bytes: bytes.byteLength,
      lines: shape.count,
      sha256: sha256(bytes),
      first_line: shape.first,
      last_line: shape.last,
    };
  });
  const zipEntries: Zippable = {};
  for (const path of members)
    zipEntries[path] = [
      files.get(path) as Uint8Array,
      { level: 6, mtime: ZIP_EPOCH, attrs: 0o644 << 16, os: 3 },
    ];
  const archiveBytes = zipSync(zipEntries);
  if (archiveBytes.byteLength > KIT_MAX_ARCHIVE_BYTES)
    throw new Error("agent kit archive exceeds size limit");
  const archiveName = `${KIT_PACKAGE}-${version}.zip`;
  const manifest = {
    package: KIT_PACKAGE,
    version,
    generated_for_origin: origin,
    min_runtime_version: "3.9",
    files: manifestFiles,
    archive: {
      path: archiveName,
      url: `${origin}/agent/pkg/${archiveName}`,
      bytes: archiveBytes.byteLength,
      sha256: sha256(archiveBytes),
    },
  };
  const manifestBytes = jsonBytes(manifest);
  return { origin, version, files, manifest, manifestBytes, archiveName, archiveBytes };
}

export type KitRouterOptions = {
  origin?: string | ((request: Request) => string);
  packageRoot?: string;
  package?: KitPackage;
};

function packageFor(request: Request, options: KitRouterOptions): KitPackage {
  if (options.package) return options.package;
  const source =
    typeof options.origin === "function"
      ? options.origin(request)
      : (options.origin ?? new URL(request.url).origin);
  return buildKitPackage(source, options.packageRoot);
}

function serveKit(request: Request, bytes: Uint8Array, type: string, maxAge: number): Response {
  const etag = `"${sha256(bytes)}"`;
  const headers = new Headers({
    "Cache-Control": `public, max-age=${maxAge}`,
    ETag: etag,
    "Content-Type": type,
  });
  if (etagMatches(request.headers.get("If-None-Match") ?? undefined, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : (bytes as unknown as BodyInit), {
    status: 200,
    headers,
  });
}

export function createKitRouter(options: KitRouterOptions = {}): Hono {
  const app = new Hono();
  const fixedPackage =
    options.package ??
    (typeof options.origin === "string"
      ? buildKitPackage(options.origin, options.packageRoot)
      : undefined);
  const resolvePackage = (request: Request) => fixedPackage ?? packageFor(request, options);
  const publicFile = (request: Request, path: string, maxAge = KIT_CACHE_SECONDS): Response => {
    const kit = resolvePackage(request);
    const bytes = kit.files.get(path);
    if (!bytes || (path !== "index.md" && !isRoutableKitPath(path))) throw notFound();
    return serveKit(request, bytes, contentType(path), maxAge);
  };
  const safe = ["GET", "HEAD"];
  app.on(safe, "/agent/", (c) => publicFile(c.req.raw, "index.md"));
  app.on(
    safe,
    "/agent-setup/SKILL.md",
    () => new Response(null, { status: 301, headers: { Location: "/agent/pkg/SKILL.md" } }),
  );
  app.on(safe, "/agent/pkg/VERSION", (c) =>
    publicFile(c.req.raw, "VERSION", KIT_VERSION_CACHE_SECONDS),
  );
  app.on(safe, "/agent/pkg/SKILL.md", (c) => publicFile(c.req.raw, "SKILL.md"));
  app.on(safe, "/agent/pkg/manifest.json", (c) => {
    const kit = resolvePackage(c.req.raw);
    return serveKit(c.req.raw, kit.manifestBytes, "application/json", KIT_CACHE_SECONDS);
  });
  app.on(safe, "/agent/pkg/:archive", (c) => {
    const kit = resolvePackage(c.req.raw);
    if (c.req.param("archive") !== kit.archiveName) throw notFound();
    return serveKit(c.req.raw, kit.archiveBytes, "application/zip", KIT_CACHE_SECONDS);
  });
  app.on(safe, "/agent/pkg/references/:name", (c) =>
    publicFile(c.req.raw, `references/${c.req.param("name")}`),
  );
  app.on(safe, "/agent/pkg/scripts/:name", (c) =>
    publicFile(c.req.raw, `scripts/${c.req.param("name")}`),
  );
  app.all("/agent/*", (c) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") throw notFound();
    throw methodNotAllowed("GET or HEAD");
  });
  app.all("/agent-setup/*", (c) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") throw notFound();
    throw methodNotAllowed("GET or HEAD");
  });
  return app;
}
