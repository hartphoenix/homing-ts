import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HomingError } from "../http";

export class AgentCoreError extends HomingError {
  constructor(
    code: string,
    message: string,
    status: ContentfulStatusCode,
    fields: Record<string, unknown> = {},
  ) {
    super(code, message, status, fields);
    this.name = "AgentCoreError";
  }
}

export function methodNotAllowed(method: string) {
  return new AgentCoreError("method_not_allowed", `${method} required`, 405);
}

export function validation(message: string, fields: Record<string, unknown> = {}) {
  return new AgentCoreError("validation_error", message, 422, fields);
}

export function notFound() {
  return new AgentCoreError("not_found", "Object not found.", 404);
}

export function forbidden(message = "You do not have permission to perform this action.") {
  return new AgentCoreError("forbidden", message, 403);
}

export function unauthorized(message = "Authentication credentials were not provided.") {
  return new AgentCoreError("authentication_required", message, 401);
}

export function conflict(code: string, message: string, fields: Record<string, unknown> = {}) {
  return new AgentCoreError(code, message, 409, fields);
}

export function cursorExpired() {
  return new AgentCoreError("cursor_expired", "The sync cursor has expired.", 410);
}
