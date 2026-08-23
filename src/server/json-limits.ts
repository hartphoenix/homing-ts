type JsonLimits = {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
};

/** Bound user-controlled JSON before it is persisted or returned to another agent. */
export function isBoundedJson(
  value: unknown,
  { maxBytes = 50_000, maxDepth = 8, maxNodes = 2_000 }: JsonLimits = {},
): boolean {
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) return false;
  } catch {
    return false;
  }
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) return false;
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) pending.push({ depth: current.depth + 1, value: child });
  }
  return true;
}
