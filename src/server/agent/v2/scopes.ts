export const V2_AGENT_SCOPES = [
  "agent-config:read",
  "source-config:write",
  "agent-runs:write",
  "agent-deliveries:write",
  "connection:self",
] as const;

export type V2AgentScope = (typeof V2_AGENT_SCOPES)[number];

/** Scope disclosed by pairing before attended setup finalization. */
export const V2_INITIAL_SCOPES = V2_AGENT_SCOPES;

/** Scope retained by the scheduled runner after setup finalization. */
export const V2_FINAL_SCOPES = V2_AGENT_SCOPES.filter(
  (scope): scope is Exclude<V2AgentScope, "source-config:write"> => scope !== "source-config:write",
);

const scopeSet: ReadonlySet<string> = new Set(V2_AGENT_SCOPES);

export function isV2AgentScope(value: string): value is V2AgentScope {
  return scopeSet.has(value);
}

export function normalizeV2Scopes(value: unknown): V2AgentScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > V2_AGENT_SCOPES.length) {
    throw new Error("v2 scopes must be a non-empty array of known scopes");
  }
  const unique = [...new Set(value)];
  if (unique.some((scope) => typeof scope !== "string" || !isV2AgentScope(scope))) {
    throw new Error("v2 scopes contains an unknown scope");
  }
  return unique.sort() as V2AgentScope[];
}
