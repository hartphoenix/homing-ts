import { z } from "zod";

export const V2_PROTOCOL_VERSION = 2 as const;

export const requiredEvidenceKeys = ["location", "price", "availability", "housing_type"] as const;
export const requiredEvidenceKeySchema = z.enum(requiredEvidenceKeys);

const objectSchema = z.record(z.string(), z.unknown());

export const acquisitionBasisSchema = z
  .object({
    locations: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => value.trim().length > 0),
      )
      .min(1)
      .refine((values) => new Set(values).size === values.length),
    min_price_minor: z.number().int().nonnegative().nullable(),
    max_price_minor: z.number().int().nonnegative().nullable(),
    housing_types: z
      .array(z.enum(["entire", "shared"]))
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
  .superRefine((basis, context) => {
    if (
      basis.min_price_minor !== null &&
      basis.max_price_minor !== null &&
      basis.min_price_minor > basis.max_price_minor
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["max_price_minor"],
        message: "max_price_minor must be at least min_price_minor",
      });
    }
  });

const requiredEvidenceSchema = z
  .array(requiredEvidenceKeySchema)
  .min(1)
  .max(requiredEvidenceKeys.length)
  .refine((values) => new Set(values).size === values.length, "required evidence must be unique");

const unknownEvidenceSchema = z
  .array(requiredEvidenceKeySchema)
  .max(requiredEvidenceKeys.length)
  .refine((values) => new Set(values).size === values.length, "unknowns must be unique");

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
    required_evidence: requiredEvidenceSchema,
    acquisition_basis: acquisitionBasisSchema,
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

export const protocolVersionSchema = z.union([z.literal(2), z.literal("v2")]);

export const v2PairingRequestSchema = z
  .object({
    protocol_version: protocolVersionSchema,
    agent_label: z.string().trim().min(1).max(120),
    environment_note: z.string().trim().max(200).optional(),
    requested_cadence_minutes: z.number().int().min(1).max(10_080).nullable().optional(),
  })
  .strict();

export const v2SourceQueryInputSchema = z
  .object({
    adapter: sourceAdapterSchema,
    query: z.object({ url: z.string().url().max(2_000) }).strict(),
  })
  .strict()
  .superRefine((source, context) => {
    let url: URL;
    try {
      url = new URL(source.query.url);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query", "url"],
        message: "URL is invalid",
      });
      return;
    }
    const hosts = {
      "zumper-com": new Set(["zumper.com", "www.zumper.com"]),
      "streeteasy-com": new Set(["streeteasy.com", "www.streeteasy.com"]),
    }[source.adapter];
    if (
      url.protocol !== "https:" ||
      !hosts.has(url.hostname.toLowerCase()) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port !== "" && url.port !== "443")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query", "url"],
        message: "URL is outside the selected source adapter",
      });
    }
  });

const sourceQueriesSchema = z
  .array(v2SourceQueryInputSchema)
  .min(1)
  .max(8)
  .superRefine((queries, context) => {
    const counts = new Map<SourceAdapter, number>();
    const identities = new Set<string>();
    for (const [index, source] of queries.entries()) {
      const count = (counts.get(source.adapter) ?? 0) + 1;
      counts.set(source.adapter, count);
      if (count > 4) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "adapter"],
          message: "no more than four queries are allowed for one adapter",
        });
      }
      const identity = `${source.adapter}:${source.query.url}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "query", "url"],
          message: "source queries must be unique",
        });
      }
      identities.add(identity);
    }
  });

export const v2ConfigCreateSchema = z
  .object({
    expected_revision: z.number().int().nonnegative().nullable().optional(),
    prompt: z.string().max(100_000),
    criteria: objectSchema,
    required_evidence: requiredEvidenceSchema,
    acquisition_basis: acquisitionBasisSchema,
    source_queries: sourceQueriesSchema,
  })
  .strict();

export const v2RunProjectSchema = z
  .object({
    project_id: z.string().uuid(),
    prompt_revision_id: z.number().int().positive(),
    prompt_revision: z.number().int().positive(),
    canonical_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    queries: z
      .array(
        z
          .object({
            source_query_revision_id: z.string().uuid(),
            source_query_revision: z.number().int().positive(),
            canonical_sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export const v2RunCreateSchema = z
  .object({
    invocation_id: z.string().uuid(),
    agent_label: z.string().trim().min(1).max(160),
    projects: z.array(v2RunProjectSchema).min(1).max(100),
  })
  .strict();

export const v2DeliveryLeadSchema = z
  .object({
    source: sourceAdapterSchema,
    source_listing_id: z.string().trim().min(1).max(300),
    canonical_url: z.string().url().max(2_000),
    title: z.string().max(500),
    summary: z.string().max(10_000),
    location: z.string().max(500),
    price_display: z.string().max(200),
    price_amount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .nullable(),
    price_currency: z.string().regex(/^[A-Z]{3}$/),
    availability: z.string().max(500),
    housing_type: z.enum(["entire", "shared", "unknown"]),
    listed_at: z.string().date().nullable(),
    attributes: objectSchema,
    verification_notes: z.string().max(5_000),
  })
  .strict();

export const v2DeliverySchema = z
  .object({
    prompt_revision_id: z.number().int().positive(),
    facts_hash: z.string().regex(/^[0-9a-f]{64}$/),
    disposition: z.literal("kept"),
    reason: z.string().max(500),
    unknowns: unknownEvidenceSchema,
    lead: v2DeliveryLeadSchema,
  })
  .strict();

export const v2PauseSchema = z
  .object({
    paused: z.boolean().optional(),
    paused_until: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((value) => value.paused !== undefined || value.paused_until !== undefined, {
    message: "paused or paused_until is required",
  });

/** Exact request shapes emitted by the reviewed Python v2 client. */
export const v2ClientConfigCreateSchema = z
  .object({
    expected_revision: z.number().int().nonnegative().nullable().optional(),
    required_evidence: requiredEvidenceSchema,
    acquisition_basis: acquisitionBasisSchema,
    source_queries: sourceQueriesSchema,
  })
  .strict();

export const v2WireConfigCreateSchema = z.union([v2ConfigCreateSchema, v2ClientConfigCreateSchema]);

export const v2ClientRunProjectSchema = z
  .object({
    project_id: z.string().uuid(),
    config_revision: z.coerce.number().int().positive(),
    config_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    source_queries: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            revision: z.coerce.number().int().positive(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export const v2ClientRunCreateSchema = z
  .object({
    invocation_id: z.string().uuid(),
    projects: z.array(v2ClientRunProjectSchema).min(1).max(100),
    phase: z.literal("snapshot").optional(),
  })
  .strict();

export const v2WireRunCreateSchema = z.union([v2RunCreateSchema, v2ClientRunCreateSchema]);

export const v2ClientDeliveryLeadSchema = z
  .object({
    source: sourceAdapterSchema,
    source_listing_id: z.string().trim().min(1).max(300),
    url: z.string().url().max(2_000),
    title: z.string().max(500),
    summary: z.string().max(10_000),
    location: z.string().max(500),
    price_amount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .nullable(),
    price_display: z.string().max(200),
    availability: z.string().max(500),
    housing_type: z.enum(["entire", "shared", "unknown"]),
  })
  .strict();

export const v2ClientDeliverySchema = z
  .object({
    prompt_revision: z.coerce.number().int().positive(),
    facts_hash: z.string().regex(/^[0-9a-f]{64}$/),
    lead: v2ClientDeliveryLeadSchema,
  })
  .strict();

export const v2WireDeliverySchema = z.union([v2DeliverySchema, v2ClientDeliverySchema]);

export type RequiredEvidenceKey = (typeof requiredEvidenceKeys)[number];
export type SourceAdapter = z.infer<typeof sourceAdapterSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export type MatchDisposition = z.infer<typeof matchDispositionSchema>;
export type RunQueryStatus = z.infer<typeof runQueryStatusSchema>;
export type RunPhase = z.infer<typeof runPhaseSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type AgentRunReport = z.infer<typeof agentRunReportSchema>;
