import type { AgentTokenRecord } from "../../auth/types";
import type { AgentRunReport, RequiredEvidenceKey, SourceAdapter } from "./schemas";

export type V2ProjectSummary = {
  id: string;
  name: string;
  slug: string;
  configStatus: "needed" | "ready";
  configRevision: number | null;
  configRevisionId: number | null;
  configSha256: string | null;
  prompt: string;
  criteria: Record<string, unknown>;
  requiredEvidence: RequiredEvidenceKey[];
  sourceQueries: Array<{
    id: string;
    revision: number;
    adapter: SourceAdapter;
    status: "needs_review" | "ready";
    sha256: string;
  }>;
  pausedUntil: Date | null;
  latestRun: Pick<V2RunRecord, "status" | "phase" | "report"> | null;
};

export type V2SourceQueryRevision = {
  id: string;
  projectId: string;
  adapter: SourceAdapter;
  revision: number;
  status: "needs_review" | "ready";
  canonicalBytes: Uint8Array;
  canonicalSha256: string;
  acquisitionBasisHash: string;
};

export type V2ConfigRevision = {
  id: number;
  projectId: string;
  revision: number;
  status: "legacy" | "needs_review" | "complete";
  canonicalBytes: Uint8Array;
  canonicalSha256: string;
  requiredEvidence: RequiredEvidenceKey[];
  sourceQueryIds: string[];
};

export type ConfigSourceQueryInput = {
  adapter: SourceAdapter;
  normalizedQuery: Record<string, unknown>;
  queryIdentity: string;
  acquisitionBasisHash: string;
  canonicalBytes: Uint8Array;
  canonicalSha256: string;
};

export type CreateConfigInput = {
  userId: number;
  projectId: string;
  expectedRevision: number | null;
  prompt: string;
  criteria: Record<string, unknown>;
  requiredEvidence: RequiredEvidenceKey[];
  acquisitionBasis: Record<string, unknown>;
  sourceQueries: ConfigSourceQueryInput[];
};

export type RunSnapshotQuery = {
  sourceQueryRevisionId: string;
  sourceQueryRevision: number;
  canonicalSha256: string;
};

export type RunSnapshotProject = {
  projectId: string;
  promptRevisionId: number | null;
  promptRevision: number;
  canonicalSha256: string;
  queries: RunSnapshotQuery[];
};

export type CreateRunInput = {
  userId: number;
  tokenId: string;
  invocationId: string;
  agentLabel: string;
  projects: RunSnapshotProject[];
};

export type V2RunRecord = {
  id: string;
  invocationId: string;
  userId: number;
  tokenId: string;
  agentLabel: string;
  status: "started" | "completed" | "incomplete" | "failed";
  phase: "snapshot" | "acquire" | "match" | "deliver" | "finish";
  projects: RunSnapshotProject[];
  report: AgentRunReport | null;
};

export type DeliveryLeadInput = {
  source: SourceAdapter;
  sourceListingId: string;
  canonicalUrl: string;
  title: string;
  summary: string;
  location: string;
  priceDisplay: string;
  priceAmount: string | null;
  priceCurrency: string;
  availability: string;
  housingType: "entire" | "shared" | "unknown";
  listedAt: string | null;
  attributes: Record<string, unknown>;
  verificationNotes: string;
};

export type DeliverInput = {
  userId: number;
  tokenId: string;
  projectId: string;
  promptRevisionId: number | null;
  promptRevision: number;
  factsHash: string;
  disposition: "kept";
  reason: string;
  unknowns: string[];
  lead: DeliveryLeadInput;
};

export type DeliverResult = {
  status: "created" | "existing";
  leadId: string;
  observationId: string;
};

export interface V2Repository {
  listProjects(userId: number): Promise<V2ProjectSummary[]>;
  getConfigRevision(
    userId: number,
    projectId: string,
    revision: number,
  ): Promise<V2ConfigRevision | null>;
  getSourceQueryRevision(
    userId: number,
    projectId: string,
    queryId: string,
  ): Promise<V2SourceQueryRevision | null>;
  createConfigRevision(input: CreateConfigInput): Promise<V2ConfigRevision>;
  createRun(input: CreateRunInput): Promise<{ run: V2RunRecord; replayed: boolean }>;
  finalizeRun(
    userId: number,
    tokenId: string,
    runId: string,
    report: AgentRunReport,
  ): Promise<{ run: V2RunRecord; replayed: boolean }>;
  deliver(input: DeliverInput): Promise<DeliverResult>;
  finalizeSourceWrite(tokenId: string, now: Date): Promise<AgentTokenRecord | null>;
  grantSourceWrite(userId: number, tokenId: string, now: Date): Promise<AgentTokenRecord | null>;
}
