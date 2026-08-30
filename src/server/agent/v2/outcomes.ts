import { type AgentRunReport, agentRunReportSchema, type RunQueryStatus } from "./schemas";

export class AgentRunInvariantError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "AgentRunInvariantError";
    this.issues = issues;
  }
}

export type RunReportValidation =
  | { ok: true; value: AgentRunReport }
  | { ok: false; issues: string[] };

const nonterminalQueryStatuses: ReadonlySet<RunQueryStatus> = new Set([
  "pending",
  "blocked",
  "unavailable",
  "malformed",
  "partial",
]);

function validateInvariants(report: AgentRunReport): string[] {
  const issues: string[] = [];
  const { counts, queries } = report;
  const completedQueries = queries.filter((query) => query.status === "completed").length;
  const attemptedQueries = queries.filter((query) => query.status !== "pending").length;
  const nonterminalQueries = queries.filter((query) => nonterminalQueryStatuses.has(query.status));

  if (counts.source_queries_total !== queries.length) {
    issues.push("source_queries_total must equal the number of query statuses");
  }
  if (counts.source_queries_attempted !== attemptedQueries) {
    issues.push("source_queries_attempted does not match query statuses");
  }
  if (counts.source_queries_completed !== completedQueries) {
    issues.push("source_queries_completed does not match query statuses");
  }
  if (new Set(queries.map((query) => query.source_query_revision_id)).size !== queries.length) {
    issues.push("each source query may appear only once in a run report");
  }
  for (const query of queries) {
    const hasError = query.error_class !== undefined && query.error_class !== null;
    if (query.status === "completed" && hasError) {
      issues.push("completed source queries cannot declare an error class");
    }
    if (query.status !== "completed" && (!hasError || query.error_class === "")) {
      issues.push("non-completed source queries require an error class");
    }
  }

  if (counts.candidates_evaluated > counts.candidates_observed) {
    issues.push("candidates_evaluated cannot exceed candidates_observed");
  }
  if (counts.candidates_kept + counts.candidates_insufficient > counts.candidates_evaluated) {
    issues.push("candidate dispositions cannot exceed candidates_evaluated");
  }
  if (counts.deliveries_acknowledged + counts.deliveries_pending > counts.candidates_kept) {
    issues.push("deliveries cannot exceed candidates_kept");
  }

  const candidateWorkPending = counts.candidates_evaluated < counts.candidates_observed;
  const deliveryWorkPending =
    counts.deliveries_acknowledged + counts.deliveries_pending < counts.candidates_kept;
  const nonterminalWork =
    nonterminalQueries.length > 0 || candidateWorkPending || deliveryWorkPending;
  const usefulWork =
    counts.source_queries_attempted > 0 ||
    counts.candidates_observed > 0 ||
    counts.deliveries_acknowledged > 0 ||
    counts.deliveries_pending > 0;

  if (report.status === "completed") {
    if (report.failure !== null) issues.push("completed runs cannot declare a failure");
    if (nonterminalQueries.length > 0)
      issues.push("completed runs require every source query to complete");
    if (counts.source_queries_attempted !== counts.source_queries_total) {
      issues.push("completed runs require every source query to be attempted");
    }
    if (candidateWorkPending) issues.push("completed runs cannot have unevaluated candidates");
    if (deliveryWorkPending || counts.deliveries_pending !== 0) {
      issues.push("completed runs cannot have pending deliveries");
    }
    if (counts.deliveries_acknowledged !== counts.candidates_kept) {
      issues.push("completed runs require every kept candidate to be acknowledged");
    }
  } else if (report.status === "incomplete") {
    if (report.failure !== null) issues.push("incomplete runs cannot declare a terminal failure");
    if (!usefulWork) issues.push("incomplete runs require useful work before noncompletion");
    if (!nonterminalWork)
      issues.push("incomplete runs require nonterminal source, candidate, or delivery work");
  } else if (report.status === "failed") {
    if (report.failure === null) issues.push("failed runs require a typed failure");
  }

  return issues;
}

export function validateAgentRunReport(input: unknown): RunReportValidation {
  const parsed = agentRunReportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => issue.message) };
  }
  const issues = validateInvariants(parsed.data);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: parsed.data };
}

export function assertAgentRunReport(input: unknown): AgentRunReport {
  const result = validateAgentRunReport(input);
  if (!result.ok) throw new AgentRunInvariantError(result.issues);
  return result.value;
}

/** Finalization accepts only terminal statuses; `started` is the stored in-progress state. */
export function assertTerminalAgentRunReport(input: unknown): AgentRunReport {
  const report = assertAgentRunReport(input);
  if (report.status === "started") {
    throw new AgentRunInvariantError(["final reports cannot have started status"]);
  }
  return report;
}

/** Removes transport-only nulls and gives replay comparison a stable query order. */
export function normalizeAgentRunReport(report: AgentRunReport): AgentRunReport {
  return {
    status: report.status,
    phase: report.phase,
    queries: [...report.queries]
      .sort((left, right) =>
        left.source_query_revision_id.localeCompare(right.source_query_revision_id),
      )
      .map((query) => ({
        source_query_revision_id: query.source_query_revision_id,
        status: query.status,
        ...(query.error_class == null ? {} : { error_class: query.error_class }),
      })),
    counts: {
      source_queries_total: report.counts.source_queries_total,
      source_queries_attempted: report.counts.source_queries_attempted,
      source_queries_completed: report.counts.source_queries_completed,
      candidates_observed: report.counts.candidates_observed,
      candidates_evaluated: report.counts.candidates_evaluated,
      candidates_kept: report.counts.candidates_kept,
      candidates_insufficient: report.counts.candidates_insufficient,
      deliveries_acknowledged: report.counts.deliveries_acknowledged,
      deliveries_pending: report.counts.deliveries_pending,
    },
    failure: report.failure ? { phase: report.failure.phase, code: report.failure.code } : null,
  };
}

export const validateRunOutcome = validateAgentRunReport;
export const assertRunOutcome = assertAgentRunReport;
