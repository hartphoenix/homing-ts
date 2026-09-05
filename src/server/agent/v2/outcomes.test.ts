import { describe, expect, it } from "vitest";

import {
  assertAgentRunReport,
  assertTerminalAgentRunReport,
  normalizeAgentRunReport,
  validateAgentRunReport,
} from "./outcomes";

const queryId = "11111111-1111-4111-8111-111111111111";
const otherQueryId = "22222222-2222-4222-8222-222222222222";

function report(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    phase: "finish",
    queries: [{ source_query_revision_id: queryId, status: "completed" }],
    counts: {
      source_queries_total: 1,
      source_queries_attempted: 1,
      source_queries_completed: 1,
      candidates_observed: 1,
      candidates_evaluated: 1,
      candidates_kept: 1,
      candidates_insufficient: 0,
      deliveries_acknowledged: 1,
      deliveries_pending: 0,
    },
    failure: null,
    ...overrides,
  };
}

describe("v2 run report invariants", () => {
  it("accepts a complete report only when every kept candidate is delivered", () => {
    expect(validateAgentRunReport(report())).toMatchObject({ ok: true });
    expect(() => assertAgentRunReport(report())).not.toThrow();
  });

  it.each([
    [
      "completed with a blocked query",
      {
        queries: [{ source_query_revision_id: queryId, status: "blocked", error_class: "timeout" }],
      },
    ],
    [
      "completed with an unacknowledged delivery",
      {
        counts: {
          ...(report().counts as object),
          deliveries_acknowledged: 0,
          deliveries_pending: 1,
        },
      },
    ],
    [
      "completed with an unevaluated candidate",
      {
        counts: {
          ...(report().counts as object),
          candidates_evaluated: 0,
          candidates_kept: 0,
          deliveries_acknowledged: 0,
        },
      },
    ],
    [
      "incomplete with no useful or pending work",
      {
        status: "incomplete",
        counts: {
          ...(report().counts as object),
          source_queries_attempted: 0,
          source_queries_completed: 0,
          candidates_observed: 0,
          candidates_evaluated: 0,
          candidates_kept: 0,
          deliveries_acknowledged: 0,
        },
      },
    ],
    ["incomplete after all work is terminal", { status: "incomplete" }],
    ["failed without a typed failure", { status: "failed" }],
    [
      "non-completed query without an error class",
      { queries: [{ source_query_revision_id: queryId, status: "partial" }] },
    ],
    [
      "counts that disagree with query statuses",
      { counts: { ...(report().counts as object), source_queries_completed: 0 } },
    ],
    [
      "duplicate query identities",
      {
        queries: [
          { source_query_revision_id: queryId, status: "completed" },
          { source_query_revision_id: queryId, status: "completed" },
        ],
        counts: {
          ...(report().counts as object),
          source_queries_total: 2,
          source_queries_attempted: 2,
          source_queries_completed: 2,
        },
      },
    ],
    [
      "dispositions beyond evaluated candidates",
      { counts: { ...(report().counts as object), candidates_evaluated: 0 } },
    ],
  ])("rejects %s", (_name, overrides) => {
    expect(validateAgentRunReport(report(overrides))).toMatchObject({ ok: false });
  });

  it("requires source query counts to include every snapshotted query", () => {
    const value = report({
      queries: [
        { source_query_revision_id: queryId, status: "completed" },
        { source_query_revision_id: otherQueryId, status: "completed" },
      ],
      counts: {
        ...(report().counts as object),
        source_queries_total: 1,
        source_queries_attempted: 2,
        source_queries_completed: 2,
      },
    });
    expect(validateAgentRunReport(value)).toMatchObject({ ok: false });
  });

  it("rejects started as a final report and normalizes replay-equivalent shape", () => {
    expect(() => assertTerminalAgentRunReport(report({ status: "started" }))).toThrow(
      "final reports cannot have started status",
    );
    const withNull = report({
      queries: [{ source_query_revision_id: queryId, status: "completed", error_class: null }],
    });
    expect(normalizeAgentRunReport(assertAgentRunReport(withNull))).toEqual(
      normalizeAgentRunReport(assertAgentRunReport(report())),
    );
  });
});
