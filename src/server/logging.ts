import type { MiddlewareHandler } from "hono";

import type { AppVariables } from "./types";

const uuidSegment = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const invitationSegment = /(\/invitations\/)[^/]+/gi;
const pairingSegment = /(\/auth\/agent-links\/)[^/]+/gi;

export function redactedPath(path: string): string {
  return path
    .replace(invitationSegment, "$1:token")
    .replace(pairingSegment, "$1:code")
    .replace(uuidSegment, ":id");
}

export function requestLogger(
  write: (record: Record<string, unknown>) => void = (record) =>
    console.log(JSON.stringify(record)),
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const startedAt = performance.now();
    await next();
    write({
      level: "info",
      event: "http_request",
      request_id: context.get("requestId"),
      method: context.req.method,
      path: redactedPath(context.req.path),
      status: context.res.status,
      duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  };
}
