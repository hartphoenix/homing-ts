export type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, unknown>;
    request_id?: string;
  };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, unknown>;
  readonly requestId: string | undefined;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed with status ${status}.`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "request_failed";
    this.fields = body.error?.fields ?? {};
    this.requestId = body.error?.request_id;
  }
}

let csrfToken = "";

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function acquireCsrf(): Promise<string> {
  const response = await fetch("/api/v1/csrf", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const body = (await readBody(response)) as { csrf_token?: string } & ApiErrorBody;
  if (!response.ok) throw new ApiError(response.status, body);
  if (!body.csrf_token) throw new Error("The server did not return a CSRF token.");
  csrfToken = body.csrf_token;
  return csrfToken;
}

export async function api<T>(
  path: string,
  init: RequestInit & { mutation?: boolean } = {},
): Promise<T> {
  const result = await apiResponse<T>(path, init);
  return result.data;
}

export async function apiResponse<T>(
  path: string,
  init: RequestInit & { mutation?: boolean } = {},
): Promise<{ data: T; headers: Headers }> {
  const { mutation = false, ...requestInit } = init;
  if (mutation && !csrfToken) await acquireCsrf();
  const headers = new Headers(requestInit.headers);
  headers.set("Accept", "application/json");
  if (requestInit.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  if (mutation) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(`/api/v1${path}`, {
    ...requestInit,
    headers,
    credentials: "same-origin",
  });
  const body = await readBody(response);
  if (!response.ok) {
    if (response.status === 401 && path !== "/me" && typeof window !== "undefined") {
      clearCsrf();
      window.dispatchEvent(new CustomEvent("homing:session-expired"));
    }
    throw new ApiError(response.status, (body ?? {}) as ApiErrorBody);
  }
  return { data: body as T, headers: response.headers };
}

export async function login(email: string, password: string) {
  await acquireCsrf();
  const result = await api<{ csrf_token: string; user: User }>("/session", {
    method: "POST",
    mutation: true,
    body: JSON.stringify({ email, password }),
  });
  csrfToken = result.csrf_token;
  return result;
}

export async function registerInvitation(
  token: string,
  input: { email: string; display_name: string; password: string },
) {
  await acquireCsrf();
  const result = await api<{ csrf_token: string; project_id: string; user: User }>(
    `/invitations/${encodeURIComponent(token)}/register`,
    {
      method: "POST",
      mutation: true,
      body: JSON.stringify(input),
    },
  );
  csrfToken = result.csrf_token;
  return result;
}

export function clearCsrf(): void {
  csrfToken = "";
}

export type User = { id: number; email: string; display_name?: string; is_active?: boolean };
export type Profile = {
  display_name: string;
  timezone: string;
  bio: string;
  details: Record<string, unknown>;
  agent_paused_until: string | null;
};
export type Me = { user: User; profile: Profile | null };
export type Project = {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: "active" | "trashed";
  role?: "owner" | "editor" | "viewer";
  prompt_revision: number;
  prompt?: string;
  current_prompt?: string;
  criteria?: Record<string, unknown>;
  updated_at: string;
};
export type Lead = {
  id: string;
  project_id: string;
  source: string;
  url: string;
  title: string;
  summary: string;
  location: string;
  price_display: string;
  price_amount?: number | null;
  currency?: string;
  availability: string;
  housing_type: string;
  date_confidence: string;
  listed_at?: string | null;
  status: "active" | "trashed";
  revision: number;
  interested?: boolean;
  is_interested?: boolean;
  interest_count?: number;
  interested_users?: string[];
  comment_count?: number;
  updated_at: string;
};
export type Comment = {
  id: number | string;
  author_id: number | string;
  author_display_name?: string;
  body: string;
  created_at: string;
  edited_at: string | null;
};

export type Member = {
  user_id: number | string;
  display_name: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  is_current_user?: boolean;
};

export type AgentToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  project_ids: string[];
  expires_at: string;
  revoked_at: string | null;
};

export type SourcePlanReview = {
  id: string;
  project_id: string;
  status: "open" | "resolved";
  observed_prompt_revision: number;
  resolved_prompt_revision: number | null;
  opened_at: string;
  last_reported_at: string;
  resolved_at: string | null;
};
