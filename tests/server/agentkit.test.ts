import { createHash } from "node:crypto";

import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { AgentKitManifest } from "../../src/server/agentkit/package";
import { createApp } from "../../src/server/app";

const origin = "https://homing.test";
const app = createApp({ publicOrigin: origin, ready: async () => true });

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("agent-kit package", () => {
  it("serves a complete, byte-verifiable v3 package", async () => {
    const response = await app.request("/agent/pkg/manifest.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("set-cookie")).toBeNull();

    const manifest = (await response.json()) as AgentKitManifest;
    expect(manifest).toMatchObject({
      schema: 1,
      package: "homing-agent-kit",
      version: 3,
      min_runtime_version: 1,
    });
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toContain("SETUP.md");
    expect(paths).toContain("scripts/finalize.py");
    expect(paths).not.toContain("SKILL.md");
    expect(paths).not.toContain("index.md");

    for (const expected of manifest.files) {
      expect(expected.bytes, expected.path).toBeLessThanOrEqual(256 * 1024);
      expect(expected.url).toBe(`${origin}/agent/pkg/${expected.path}`);
      const fileResponse = await app.request(new URL(expected.url).pathname);
      expect(fileResponse.status).toBe(200);
      const bytes = new Uint8Array(await fileResponse.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      const lines = text.split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      expect(bytes.byteLength, expected.path).toBe(expected.bytes);
      expect(sha256(bytes), expected.path).toBe(expected.sha256);
      expect(lines.length, expected.path).toBe(expected.lines);
      expect(lines.at(0) ?? "", expected.path).toBe(expected.first_line);
      expect(lines.at(-1) ?? "", expected.path).toBe(expected.last_line);
      expect(text, expected.path).not.toContain("__HOMING_ORIGIN__");
    }
  });

  it("serves a deterministic archive matching the manifest", async () => {
    const manifestResponse = await app.request("/agent/pkg/manifest.json");
    const manifest = (await manifestResponse.json()) as AgentKitManifest;
    expect(manifest.archive.url).toBe(`${origin}/agent/pkg/homing-agent-kit-3.zip`);
    expect(manifest.archive.bytes).toBeLessThanOrEqual(256 * 1024);

    const first = new Uint8Array(
      await (await app.request("/agent/pkg/homing-agent-kit-3.zip")).arrayBuffer(),
    );
    const second = new Uint8Array(
      await (await app.request("/agent/pkg/homing-agent-kit-3.zip")).arrayBuffer(),
    );
    expect(first).toEqual(second);
    expect(first.byteLength).toBe(manifest.archive.bytes);
    expect(sha256(first)).toBe(manifest.archive.sha256);

    const expanded = unzipSync(first);
    expect(Object.keys(expanded).sort()).toEqual(manifest.files.map((file) => file.path).sort());
    for (const expected of manifest.files) {
      const member = expanded[expected.path];
      expect(member, expected.path).toBeDefined();
      expect(sha256(member as Uint8Array), expected.path).toBe(expected.sha256);
    }
  });

  it("keeps setup routes outside the SPA and restricts their method surface", async () => {
    const bootstrap = await app.request("/agent/bootstrap.py");
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("content-type")).toContain("text/x-python");
    expect(await bootstrap.text()).toContain("def safe_extract(");

    const index = await app.request("/agent/");
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/markdown");
    expect(await index.text()).toContain("# Homing — agent kit");

    const head = await app.request("/agent/pkg/SETUP.md", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toMatch(/^\d+$/);
    expect(await head.text()).toBe("");

    const etag = head.headers.get("etag") as string;
    const unchanged = await app.request("/agent/pkg/SETUP.md", {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");

    const post = await app.request("/agent/pkg/SETUP.md", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    for (const path of [
      "/agent/pkg/not-present.md",
      "/agent/pkg/../package.json",
      "/agent/pkg/references/..%2F..%2Fetc%2Fpasswd.md",
      "/agent/pkg/references/%2e%2e%2fSETUP.md",
      "/agent/pkg/scripts//etc/passwd",
      "/agent/pkg/scripts/%2Fetc%2Fshadow",
      "/agent/pkg/homing-agent-kit-2.zip",
    ]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });

  it("redirects legacy setup-skill URLs to the setup prompt", async () => {
    for (const path of ["/agent/pkg/SKILL.md", "/agent-setup/SKILL.md"]) {
      const response = await app.request(path);
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(`${origin}/agent/pkg/SETUP.md`);
    }
  });
});
