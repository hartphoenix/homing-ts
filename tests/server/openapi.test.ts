import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { API_ROUTES, buildOpenApi } from "../../src/server/openapi";

const sources = [
  "src/server/app.ts",
  "src/server/auth/router.ts",
  "src/server/collaboration/router.ts",
  "src/server/agent/runs.ts",
  "src/server/agent/changes.ts",
  "src/server/agent/source-plans.ts",
];

function runtimeOperations(): Set<string> {
  const operations = new Set<string>();
  for (const path of sources) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /\.(get|post|put|patch|delete|all)\(\s*["'](\/[^"']+)["']/g,
    )) {
      const method = match[1] as string;
      const routePath = (match[2] as string)
        .replaceAll(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}")
        .replace(/^\/(?!health)/, "/api/v1/");
      if (routePath.includes("*") || routePath.startsWith("/api/v1/assets")) {
        continue;
      }
      if (method === "all") {
        operations.add(`get ${routePath}`);
        operations.add(`post ${routePath}`);
      } else {
        operations.add(`${method} ${routePath}`);
      }
    }
  }
  return operations;
}

describe("machine-readable API contract", () => {
  it("contains every statically declared JSON route and no duplicate operation", () => {
    const documented = new Set(API_ROUTES.map((route) => `${route.method} ${route.path}`));
    expect(documented.size).toBe(API_ROUTES.length);
    for (const operation of runtimeOperations()) expect(documented).toContain(operation);
  });

  it("keeps generated inventory and OpenAPI files current", () => {
    expect(JSON.parse(readFileSync("docs/route-inventory.json", "utf8"))).toEqual(API_ROUTES);
    expect(JSON.parse(readFileSync("docs/openapi.json", "utf8"))).toEqual(buildOpenApi());
  });

  it("marks session mutations for CSRF and pairing polls as deliberate exemptions", () => {
    const document = buildOpenApi() as {
      paths: Record<string, Record<string, { security: unknown[]; "x-homing-csrf": boolean }>>;
    };
    expect(document.paths["/api/v1/session"]?.post?.["x-homing-csrf"]).toBe(true);
    expect(document.paths["/api/v1/invitations/{token}/register"]?.post?.["x-homing-csrf"]).toBe(
      true,
    );
    expect(document.paths["/api/v1/agent-link"]?.post).toMatchObject({
      security: [],
      "x-homing-csrf": false,
    });
    expect(document.paths["/api/v1/agent-link/token"]?.post).toMatchObject({
      security: [],
      "x-homing-csrf": false,
    });
  });
});
