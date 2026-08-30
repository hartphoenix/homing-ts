export const AGENT_SCOPES = [
  "profile:read",
  "projects:read",
  "prompts:read",
  "leads:read",
  "leads:write",
  "leads:destroy",
  "comments:read",
  "comments:write",
  "interest:read",
  "interest:write",
  "runs:write",
] as const;

export const V2_AGENT_SCOPES = [
  "agent-config:read",
  "source-config:write",
  "agent-runs:write",
  "agent-deliveries:write",
  "connection:self",
] as const;

export type AgentScope = (typeof AGENT_SCOPES | typeof V2_AGENT_SCOPES)[number];
export const AGENT_SCOPE_SET: ReadonlySet<string> = new Set(AGENT_SCOPES);
export const V2_AGENT_SCOPE_SET: ReadonlySet<string> = new Set(V2_AGENT_SCOPES);

/** Pairing is deliberately non-destructive. Human-created keys may opt into trash/restore. */
export const PAIRED_AGENT_SCOPES = AGENT_SCOPES.filter((scope) => scope !== "leads:destroy");

export function normalizeScopes(value: unknown, paired = false): AgentScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > AGENT_SCOPES.length) {
    throw new Error("scopes must be a non-empty array of known scopes");
  }
  const unique = [...new Set(value)];
  if (unique.some((scope) => typeof scope !== "string" || !AGENT_SCOPE_SET.has(scope))) {
    throw new Error("scopes contains an unknown scope");
  }
  if (paired && unique.includes("leads:destroy")) {
    throw new Error("paired tokens cannot carry leads:destroy");
  }
  return unique.sort() as AgentScope[];
}
