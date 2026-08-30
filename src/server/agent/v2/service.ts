import type { AgentTokenRecord, Principal } from "../../auth/types";
import { HomingError } from "../../http";
import { canonicalJsonBytes, canonicalJsonSha256 } from "./canonical";
import { sourceQueryIdentity } from "./identities";
import { assertTerminalAgentRunReport } from "./outcomes";
import type {
  CreateConfigInput,
  CreateRunInput,
  DeliverInput,
  V2ConfigRevision,
  V2Repository,
} from "./repository";
import type {
  v2WireConfigCreateSchema,
  v2WireDeliverySchema,
  v2WireRunCreateSchema,
} from "./schemas";

type V2ConfigCreate = import("zod").infer<typeof v2WireConfigCreateSchema>;
type V2Delivery = import("zod").infer<typeof v2WireDeliverySchema>;
type V2RunCreate = import("zod").infer<typeof v2WireRunCreateSchema>;

export class V2Service {
  constructor(private readonly repository: V2Repository) {}

  requireAgent(principal: Principal): AgentTokenRecord {
    if (principal.kind !== "agent" || !principal.token) {
      throw new HomingError("forbidden", "A v2 bearer token is required.", 403);
    }
    return principal.token;
  }

  requireScope(principal: Principal, scope: string): AgentTokenRecord {
    const token = this.requireAgent(principal);
    if (!token.scopes.includes(scope as (typeof token.scopes)[number])) {
      throw new HomingError("forbidden", "Token lacks the required v2 scope.", 403, { scope });
    }
    return token;
  }

  requireSourceWrite(principal: Principal, now: Date): AgentTokenRecord {
    const token = this.requireScope(principal, "source-config:write");
    if (!token.sourceWriteExpiresAt || token.sourceWriteExpiresAt <= now) {
      throw new HomingError(
        "source_refresh_required",
        "Attended source configuration authority has expired.",
        403,
      );
    }
    return token;
  }

  async createConfig(
    userId: number,
    projectId: string,
    body: V2ConfigCreate,
  ): Promise<V2ConfigRevision> {
    // The client intentionally omits prompt and criteria. The repository resolves them while
    // holding the project lock so a concurrent brief edit cannot produce a mixed revision.
    const prompt = "prompt" in body ? body.prompt : undefined;
    const criteria = "prompt" in body ? body.criteria : undefined;
    const acquisitionBasisHash = canonicalJsonSha256(body.acquisition_basis);
    const sourceQueries = body.source_queries.map((source) => {
      const queryIdentity = sourceQueryIdentity(projectId, source.adapter, source.query);
      const payload = {
        version: 1,
        adapter: source.adapter,
        query: source.query,
        acquisition_basis_hash: acquisitionBasisHash,
      };
      const canonicalBytes = canonicalJsonBytes(payload);
      return {
        adapter: source.adapter,
        normalizedQuery: source.query,
        queryIdentity,
        acquisitionBasisHash,
        canonicalBytes,
        canonicalSha256: canonicalJsonSha256(payload),
      };
    });
    const input: CreateConfigInput = {
      userId,
      projectId,
      expectedRevision: body.expected_revision ?? null,
      requiredEvidence: body.required_evidence,
      acquisitionBasis: body.acquisition_basis,
      sourceQueries,
      ...(prompt === undefined ? {} : { prompt }),
      ...(criteria === undefined ? {} : { criteria }),
    };
    return this.repository.createConfigRevision(input);
  }

  async createRun(userId: number, tokenId: string, agentLabel: string, body: V2RunCreate) {
    const internal = "agent_label" in body;
    const input: CreateRunInput = {
      userId,
      tokenId,
      invocationId: body.invocation_id,
      agentLabel: internal ? body.agent_label : agentLabel,
      projects: body.projects.map((project) =>
        "prompt_revision_id" in project
          ? {
              projectId: project.project_id,
              promptRevisionId: project.prompt_revision_id,
              promptRevision: project.prompt_revision,
              canonicalSha256: project.canonical_sha256,
              queries: project.queries.map((query) => ({
                sourceQueryRevisionId: query.source_query_revision_id,
                sourceQueryRevision: query.source_query_revision,
                canonicalSha256: query.canonical_sha256,
              })),
            }
          : {
              projectId: project.project_id,
              promptRevisionId: null,
              promptRevision: project.config_revision,
              canonicalSha256: project.config_sha256,
              queries: project.source_queries.map((query) => ({
                sourceQueryRevisionId: query.id,
                sourceQueryRevision: query.revision,
                canonicalSha256: query.sha256,
              })),
            },
      ),
    };
    return this.repository.createRun(input);
  }

  async finalizeRun(userId: number, tokenId: string, runId: string, report: unknown) {
    let value: ReturnType<typeof assertTerminalAgentRunReport>;
    try {
      value = assertTerminalAgentRunReport(report);
    } catch (error) {
      throw new HomingError("validation_error", "The run report violates v2 invariants.", 422, {
        issues: error instanceof Error ? error.message.split("; ") : [],
      });
    }
    return this.repository.finalizeRun(userId, tokenId, runId, value);
  }

  async deliver(userId: number, tokenId: string, projectId: string, body: V2Delivery) {
    const internal = "prompt_revision_id" in body;
    const input: DeliverInput = {
      userId,
      tokenId,
      projectId,
      promptRevisionId: internal ? body.prompt_revision_id : null,
      promptRevision: internal ? body.prompt_revision_id : body.prompt_revision,
      factsHash: body.facts_hash,
      disposition: "kept",
      reason: internal ? body.reason : "",
      unknowns: internal ? body.unknowns : [],
      lead: {
        source: body.lead.source,
        sourceListingId: body.lead.source_listing_id,
        canonicalUrl: internal ? body.lead.canonical_url : body.lead.url,
        title: body.lead.title,
        summary: body.lead.summary,
        location: body.lead.location,
        priceDisplay: body.lead.price_display,
        priceAmount: body.lead.price_amount,
        priceCurrency: internal ? body.lead.price_currency : "USD",
        availability: body.lead.availability,
        housingType: body.lead.housing_type,
        listedAt: internal ? body.lead.listed_at : null,
        attributes: internal ? body.lead.attributes : {},
        verificationNotes: internal ? body.lead.verification_notes : "",
      },
    };
    return this.repository.deliver(input);
  }

  async getConfig(userId: number, projectId: string, revision: number) {
    return this.repository.getConfigRevision(userId, projectId, revision);
  }

  async getSourceQuery(userId: number, projectId: string, queryId: string) {
    return this.repository.getSourceQueryRevision(userId, projectId, queryId);
  }
}
