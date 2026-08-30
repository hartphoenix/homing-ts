import { z } from "zod";

export const V2_PROTOCOL_VERSION = 2 as const;

export const requiredEvidenceKeys = ["location", "price", "availability", "housing_type"] as const;
export const requiredEvidenceKeySchema = z.enum(requiredEvidenceKeys);

const objectSchema = z.record(z.string(), z.unknown());

export const evidenceStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("present"), value: z.unknown() }).strict(),
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("unknown") }).strict(),
]);

export const evidenceSchema = z
  .object({
    location: evidenceStateSchema,
    price: evidenceStateSchema,
    availability: evidenceStateSchema,
    housing_type: evidenceStateSchema,
  })
  .strict();

export const sourceAdapterSchema = z.enum(["zumper-com", "streeteasy-com"]);
export const sourceQueryStatusSchema = z.enum(["needs_review", "ready"]);

export const sourceQueryPayloadSchema = z
  .object({
    version: z.literal(1),
    adapter: sourceAdapterSchema,
    query: objectSchema,
    acquisition_basis_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const sourceQueryReferenceSchema = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    position: z.number().int().nonnegative().max(7),
  })
  .strict();

export const configRevisionPayloadSchema = z
  .object({
    version: z.literal(1),
    prompt: z.string(),
    criteria: objectSchema,
    required_evidence: z.array(requiredEvidenceKeySchema).max(requiredEvidenceKeys.length),
    acquisition_basis: objectSchema,
    source_queries: z.array(sourceQueryReferenceSchema).max(8),
  })
  .strict();

export const matchObservationFactsSchema = z
  .object({
    source: sourceAdapterSchema,
    source_listing_id: z.string().min(1).max(300),
    canonical_url: z.string().url().max(2000),
    title: z.string().max(500),
    description: z.string().max(2000),
    evidence: evidenceSchema,
  })
  .strict();

export const matchDispositionSchema = z.enum(["pending", "rejected", "insufficient", "kept"]);
export const runPhaseSchema = z.enum(["snapshot", "acquire", "match", "deliver", "finish"]);
export const runStatusSchema = z.enum(["started", "completed", "incomplete", "failed"]);
export const runQueryStatusSchema = z.enum([
  "pending",
  "completed",
  "blocked",
  "unavailable",
  "malformed",
  "partial",
]);

export const runQueryReportSchema = z
  .object({
    source_query_revision_id: z.string().uuid(),
    status: runQueryStatusSchema,
    error_class: z.string().max(64).nullable().optional(),
  })
  .strict();

const countSchema = z.number().int().nonnegative();

export const runCountsSchema = z
  .object({
    source_queries_total: countSchema,
    source_queries_attempted: countSchema,
    source_queries_completed: countSchema,
    candidates_observed: countSchema,
    candidates_evaluated: countSchema,
    candidates_kept: countSchema,
    candidates_insufficient: countSchema,
    deliveries_acknowledged: countSchema,
    deliveries_pending: countSchema,
  })
  .strict();

export const runFailureSchema = z
  .object({
    phase: runPhaseSchema,
    code: z.string().min(1).max(64),
  })
  .strict();

export const agentRunReportSchema = z
  .object({
    status: runStatusSchema,
    phase: runPhaseSchema,
    queries: z.array(runQueryReportSchema).max(8),
    counts: runCountsSchema,
    failure: runFailureSchema.nullable(),
  })
  .strict();

export type RequiredEvidenceKey = (typeof requiredEvidenceKeys)[number];
export type SourceAdapter = z.infer<typeof sourceAdapterSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export type MatchDisposition = z.infer<typeof matchDispositionSchema>;
export type RunQueryStatus = z.infer<typeof runQueryStatusSchema>;
export type RunPhase = z.infer<typeof runPhaseSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type AgentRunReport = z.infer<typeof agentRunReportSchema>;
