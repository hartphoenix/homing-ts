export type RouteDefinition = {
  method: "delete" | "get" | "head" | "patch" | "post" | "put";
  path: string;
  classification: "agent-required" | "browser-required" | "compatibility" | "public";
  auth: "either" | "public" | "session";
  status?: 200 | 201 | 204 | 301;
  body?: boolean;
};

const route = (
  method: RouteDefinition["method"],
  path: string,
  classification: RouteDefinition["classification"],
  auth: RouteDefinition["auth"],
  options: Pick<RouteDefinition, "body" | "status"> = {},
): RouteDefinition => ({ method, path, classification, auth, ...options });

export const API_ROUTES: readonly RouteDefinition[] = [
  route("get", "/health/live", "public", "public"),
  route("get", "/health/ready", "public", "public"),
  route("get", "/api/v1/csrf", "browser-required", "public"),
  route("post", "/api/v1/invitations/{token}/register", "browser-required", "public", {
    body: true,
    status: 201,
  }),
  route("get", "/api/v1/invitations/{token}/accept", "browser-required", "public"),
  route("post", "/api/v1/invitations/{token}/accept", "browser-required", "session"),
  route("post", "/api/v1/session", "browser-required", "public", { body: true }),
  route("delete", "/api/v1/session", "browser-required", "session", { status: 204 }),
  route("get", "/api/v1/me", "browser-required", "either"),
  route("get", "/api/v1/me/profile", "browser-required", "either"),
  route("patch", "/api/v1/me/profile", "browser-required", "session", { body: true }),
  route("get", "/api/v1/me/token", "agent-required", "either"),
  route("get", "/api/v1/auth/tokens", "browser-required", "session"),
  route("post", "/api/v1/auth/tokens", "browser-required", "session", {
    body: true,
    status: 201,
  }),
  route("delete", "/api/v1/auth/tokens/{id}", "browser-required", "session", {
    status: 204,
  }),
  route("post", "/api/v1/agent-link", "agent-required", "public", {
    body: true,
    status: 201,
  }),
  route("post", "/api/v1/agent-link/token", "agent-required", "public", { body: true }),
  route("get", "/api/v1/auth/agent-links/{code}", "browser-required", "session"),
  route("post", "/api/v1/auth/agent-links/{code}", "browser-required", "session", {
    body: true,
  }),
  route("get", "/api/v1/me/projects", "agent-required", "either"),
  route("post", "/api/v1/projects", "browser-required", "session", {
    body: true,
    status: 201,
  }),
  route("get", "/api/v1/projects/{projectId}", "agent-required", "either"),
  route("patch", "/api/v1/projects/{projectId}", "browser-required", "session", {
    body: true,
  }),
  route("delete", "/api/v1/projects/{projectId}", "browser-required", "session"),
  route("post", "/api/v1/projects/{projectId}/restore", "browser-required", "session"),
  route("get", "/api/v1/projects/{projectId}/prompt", "agent-required", "either"),
  route("get", "/api/v1/projects/{projectId}/prompt/revisions", "browser-required", "either"),
  route("get", "/api/v1/projects/{projectId}/prompt-revisions", "compatibility", "either"),
  route("patch", "/api/v1/projects/{projectId}/prompt", "browser-required", "session", {
    body: true,
  }),
  route("put", "/api/v1/projects/{projectId}/prompt", "compatibility", "session", {
    body: true,
  }),
  route("get", "/api/v1/projects/{projectId}/members", "browser-required", "session"),
  route("post", "/api/v1/projects/{projectId}/invitations", "browser-required", "session", {
    body: true,
    status: 201,
  }),
  route("patch", "/api/v1/projects/{projectId}/members", "compatibility", "session", {
    body: true,
  }),
  route("delete", "/api/v1/projects/{projectId}/members", "compatibility", "session", {
    body: true,
    status: 204,
  }),
  route("patch", "/api/v1/projects/{projectId}/members/{userId}", "browser-required", "session", {
    body: true,
  }),
  route("delete", "/api/v1/projects/{projectId}/members/{userId}", "browser-required", "session", {
    status: 204,
  }),
  route("get", "/api/v1/projects/{projectId}/leads", "agent-required", "either"),
  route("post", "/api/v1/projects/{projectId}/leads", "agent-required", "either", {
    body: true,
    status: 201,
  }),
  route("get", "/api/v1/projects/{projectId}/leads/interested", "compatibility", "either"),
  route("get", "/api/v1/projects/{projectId}/interested", "compatibility", "either"),
  route("get", "/api/v1/projects/{projectId}/leads/trash", "compatibility", "either"),
  route("get", "/api/v1/projects/{projectId}/trash", "browser-required", "either"),
  route("post", "/api/v1/projects/{projectId}/leads/bulk-upsert", "agent-required", "either", {
    body: true,
  }),
  route("post", "/api/v1/projects/{projectId}/leads/batch", "compatibility", "either", {
    body: true,
  }),
  route("get", "/api/v1/projects/{projectId}/leads/{leadId}", "agent-required", "either"),
  route("patch", "/api/v1/projects/{projectId}/leads/{leadId}", "browser-required", "either", {
    body: true,
  }),
  route("delete", "/api/v1/projects/{projectId}/leads/{leadId}", "browser-required", "either"),
  route("post", "/api/v1/projects/{projectId}/leads/{leadId}/restore", "compatibility", "either"),
  route(
    "post",
    "/api/v1/projects/{projectId}/trash/{leadId}/restore",
    "browser-required",
    "either",
  ),
  route(
    "delete",
    "/api/v1/projects/{projectId}/leads/{leadId}/permanent",
    "compatibility",
    "either",
    { status: 204 },
  ),
  route("post", "/api/v1/projects/{projectId}/leads/{leadId}/interest", "compatibility", "either", {
    body: true,
  }),
  route(
    "put",
    "/api/v1/projects/{projectId}/leads/{leadId}/interest",
    "browser-required",
    "either",
    { status: 204 },
  ),
  route(
    "delete",
    "/api/v1/projects/{projectId}/leads/{leadId}/interest",
    "browser-required",
    "either",
    { status: 204 },
  ),
  route(
    "get",
    "/api/v1/projects/{projectId}/leads/{leadId}/comments",
    "browser-required",
    "either",
  ),
  route(
    "post",
    "/api/v1/projects/{projectId}/leads/{leadId}/comments",
    "agent-required",
    "either",
    { body: true, status: 201 },
  ),
  route(
    "patch",
    "/api/v1/projects/{projectId}/leads/{leadId}/comments/{commentId}",
    "browser-required",
    "either",
    { body: true },
  ),
  route(
    "delete",
    "/api/v1/projects/{projectId}/leads/{leadId}/comments/{commentId}",
    "browser-required",
    "either",
    { status: 204 },
  ),
  route("get", "/api/v1/projects/{projectId}/search-runs", "agent-required", "either"),
  route("post", "/api/v1/projects/{projectId}/search-runs", "agent-required", "either", {
    body: true,
    status: 201,
  }),
  route("get", "/api/v1/projects/{projectId}/search-runs/{runId}", "agent-required", "either"),
  route(
    "post",
    "/api/v1/projects/{projectId}/search-runs/{runId}/claim",
    "agent-required",
    "either",
  ),
  route(
    "post",
    "/api/v1/projects/{projectId}/search-runs/{runId}/heartbeat",
    "agent-required",
    "either",
    { body: true },
  ),
  route(
    "post",
    "/api/v1/projects/{projectId}/search-runs/{runId}/complete",
    "agent-required",
    "either",
    { body: true },
  ),
  route("get", "/api/v1/projects/{projectId}/changes", "agent-required", "either"),
  route("get", "/api/v1/me/source-plan-reviews", "agent-required", "either"),
  route("post", "/api/v1/projects/{projectId}/source-plan-review", "agent-required", "either", {
    body: true,
    status: 201,
  }),
  route(
    "post",
    "/api/v1/projects/{projectId}/source-plan-review/{reviewId}/resolve",
    "agent-required",
    "either",
    { body: true },
  ),
  route("get", "/api/v1/me/source-plan-repair", "browser-required", "either"),
  route("get", "/agent/", "public", "public"),
  route("head", "/agent/", "public", "public"),
  route("get", "/agent-setup/SKILL.md", "compatibility", "public", { status: 301 }),
  route("head", "/agent-setup/SKILL.md", "compatibility", "public", { status: 301 }),
  route("get", "/agent/pkg/VERSION", "public", "public"),
  route("head", "/agent/pkg/VERSION", "public", "public"),
  route("get", "/agent/pkg/SKILL.md", "public", "public"),
  route("head", "/agent/pkg/SKILL.md", "public", "public"),
  route("get", "/agent/pkg/manifest.json", "public", "public"),
  route("head", "/agent/pkg/manifest.json", "public", "public"),
  route("get", "/agent/pkg/{archive}", "public", "public"),
  route("head", "/agent/pkg/{archive}", "public", "public"),
  route("get", "/agent/pkg/references/{name}", "public", "public"),
  route("head", "/agent/pkg/references/{name}", "public", "public"),
  route("get", "/agent/pkg/scripts/{name}", "public", "public"),
  route("head", "/agent/pkg/scripts/{name}", "public", "public"),
];

function parameter(name: string) {
  const integer = name === "userId" || name === "commentId";
  const uuid = ["id", "projectId", "leadId", "runId", "reviewId"].includes(name);
  return {
    in: "path",
    name,
    required: true,
    schema: integer
      ? { type: "integer", minimum: 1 }
      : uuid
        ? { type: "string", format: "uuid" }
        : { type: "string", minLength: 1 },
  };
}

function security(auth: RouteDefinition["auth"]) {
  if (auth === "public") return [];
  if (auth === "session") return [{ cookieSession: [] }];
  return [{ cookieSession: [] }, { bearerAuth: [] }];
}

function successContent(routeDefinition: RouteDefinition) {
  if (routeDefinition.method === "head" || routeDefinition.status === 204) return undefined;
  if (routeDefinition.status === 301) return undefined;
  let mediaType = "application/json";
  let schema: Record<string, unknown> = { $ref: "#/components/schemas/JsonValue" };
  if (routeDefinition.path === "/agent/" || routeDefinition.path.endsWith(".md")) {
    mediaType = "text/markdown";
    schema = { type: "string" };
  } else if (
    routeDefinition.path === "/agent/pkg/VERSION" ||
    routeDefinition.path.includes("/scripts/")
  ) {
    mediaType = "text/plain";
    schema = { type: "string" };
  } else if (routeDefinition.path === "/agent/pkg/{archive}") {
    mediaType = "application/zip";
    schema = { type: "string", format: "binary" };
  }
  return { [mediaType]: { schema } };
}

function operation(routeDefinition: RouteDefinition) {
  const parameters = [...routeDefinition.path.matchAll(/\{([^}]+)\}/g)].map((match) =>
    parameter(match[1] as string),
  );
  const status = String(routeDefinition.status ?? 200);
  const content = successContent(routeDefinition);
  const requiresCsrf =
    ((routeDefinition.auth === "session" && !["get", "head"].includes(routeDefinition.method)) ||
      routeDefinition.path === "/api/v1/session" ||
      routeDefinition.path.endsWith("/register")) &&
    routeDefinition.method !== "get";
  return {
    operationId: `${routeDefinition.method}_${routeDefinition.path}`
      .replaceAll(/[^A-Za-z0-9]+/g, "_")
      .replaceAll(/^_|_$/g, ""),
    summary: `${routeDefinition.method.toUpperCase()} ${routeDefinition.path}`,
    tags: [routeDefinition.classification],
    security: security(routeDefinition.auth),
    "x-homing-classification": routeDefinition.classification,
    "x-homing-csrf": requiresCsrf,
    ...(parameters.length || requiresCsrf
      ? {
          parameters: [
            ...parameters,
            ...(requiresCsrf
              ? [
                  {
                    in: "header",
                    name: "X-CSRF-Token",
                    required: true,
                    schema: { type: "string", minLength: 1, maxLength: 256 },
                  },
                ]
              : []),
          ],
        }
      : {}),
    ...(routeDefinition.body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/JsonObject" } },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description:
          routeDefinition.status === 204
            ? "No content"
            : routeDefinition.status === 301
              ? "Permanent redirect"
              : "Success",
        headers: {
          "X-Request-ID": { schema: { type: "string" } },
          ...(routeDefinition.status === 301
            ? { Location: { required: true, schema: { type: "string" } } }
            : {}),
        },
        ...(content ? { content } : {}),
      },
      default: {
        description: "Standard Homing error",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorEnvelope" } },
        },
      },
    },
  };
}

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const routeDefinition of API_ROUTES) {
    paths[routeDefinition.path] ??= {};
    const path = paths[routeDefinition.path] as Record<string, unknown>;
    if (path[routeDefinition.method]) {
      throw new Error(
        `Duplicate OpenAPI operation: ${routeDefinition.method} ${routeDefinition.path}`,
      );
    }
    path[routeDefinition.method] = operation(routeDefinition);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Homing API",
      version: "1.0.0-rc.1",
      description:
        "Machine-readable route, method, authentication, and common-envelope contract. Field-level invariants consumed by the unchanged Python client remain locked by its real-client acceptance suite.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        cookieSession: { type: "apiKey", in: "cookie", name: "__Host-homing_session" },
      },
      schemas: {
        JsonObject: { type: "object", additionalProperties: true },
        JsonValue: {},
        ErrorEnvelope: {
          type: "object",
          required: ["error"],
          additionalProperties: false,
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "request_id"],
              additionalProperties: false,
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                fields: { type: "object", additionalProperties: true },
                request_id: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function generate(check: boolean): Promise<void> {
  const outputs = [
    ["docs/route-inventory.json", serialized(API_ROUTES)],
    ["docs/openapi.json", serialized(buildOpenApi())],
  ] as const;
  for (const [path, expected] of outputs) {
    if (check) {
      const actual = await Bun.file(path).text();
      if (actual !== expected) throw new Error(`${path} is stale; run bun run api:generate.`);
    } else {
      await Bun.write(path, expected);
    }
  }
}

if (import.meta.main) await generate(process.argv.includes("--check"));
