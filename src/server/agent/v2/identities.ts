import { canonicalJsonSha256 } from "./canonical";
import type { SourceAdapter } from "./schemas";
import { sourceAdapterSchema } from "./schemas";

const sha256Pattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function digestInput(value: unknown): string {
  return canonicalJsonSha256(value);
}

function normalizedText(value: string, label: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

export function normalizeSource(source: string): SourceAdapter {
  const parsed = sourceAdapterSchema.safeParse(source.normalize("NFC").trim().toLowerCase());
  if (!parsed.success) throw new Error("source must be a supported v2 adapter identity");
  return parsed.data;
}

export function normalizeListingId(listingId: string): string {
  return normalizedText(listingId, "source listing ID");
}

export function normalizeFactsHash(factsHash: string): string {
  const normalized = factsHash.trim().toLowerCase();
  if (!sha256Pattern.test(normalized)) throw new Error("facts hash must be a SHA-256 digest");
  return normalized;
}

export function normalizeUuid(value: string, label = "UUID"): string {
  const normalized = value.trim().toLowerCase();
  if (!uuidPattern.test(normalized)) throw new Error(`${label} must be a UUID`);
  return normalized;
}

/** Identity of one immutable source query within a project and adapter. */
export function sourceQueryIdentity(
  projectId: string,
  adapter: string,
  normalizedQuery: Record<string, unknown>,
): string {
  return digestInput({
    project_id: normalizeUuid(projectId, "project ID"),
    adapter: normalizeSource(adapter),
    query: normalizedQuery,
  });
}

/** Identity of an immutable match observation for one lead and prompt revision. */
export function matchObservationIdentity(input: {
  leadId: string;
  promptRevisionId: number | string;
  factsHash: string;
}): string {
  return digestInput({
    lead_id: normalizeUuid(input.leadId, "lead ID"),
    prompt_revision_id: String(input.promptRevisionId),
    facts_hash: normalizeFactsHash(input.factsHash),
  });
}

/** Stable delivery idempotency key; the facts hash distinguishes changed observations. */
export function deliveryIdempotencyKey(input: {
  projectId: string;
  promptRevision: number;
  source: string;
  sourceListingId: string;
  factsHash: string;
}): string {
  const digest = digestInput({
    project_id: normalizeUuid(input.projectId, "project ID"),
    prompt_revision: input.promptRevision,
    source: normalizeSource(input.source),
    source_listing_id: normalizeListingId(input.sourceListingId),
    facts_hash: normalizeFactsHash(input.factsHash),
  });
  return `v2-${digest}`;
}

/** The invocation UUID is the server idempotency identity for run creation. */
export function invocationIdentity(invocationId: string): string {
  return normalizeUuid(invocationId, "invocation ID");
}
