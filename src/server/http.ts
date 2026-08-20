import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AppVariables } from "./types";

export type ErrorFields = Record<string, unknown>;

export class HomingError extends Error {
  readonly code: string;
  readonly status: ContentfulStatusCode;
  readonly fields: ErrorFields;

  constructor(
    code: string,
    message: string,
    status: ContentfulStatusCode,
    fields: ErrorFields = {},
  ) {
    super(message);
    this.name = "HomingError";
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export function errorResponse(context: Context<{ Variables: AppVariables }>, error: HomingError) {
  return context.json(
    {
      error: {
        code: error.code,
        message: error.message,
        fields: error.fields,
        request_id: context.get("requestId"),
      },
    },
    error.status,
  );
}
