import { describe, expect, it } from "vitest";

import {
  deliveryIdempotencyKey,
  matchObservationIdentity,
  normalizeV2Scopes,
  sourceQueryIdentity,
} from "./index";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const leadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const factsHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("v2 identities and scopes", () => {
  it("keeps source, observation, and delivery identities stable across object ordering", () => {
    expect(
      sourceQueryIdentity(projectId, "zumper-com", { city: "New York", max_price: 2400 }),
    ).toBe(sourceQueryIdentity(projectId, "ZUMPER-COM", { max_price: 2400, city: "New York" }));
    expect(matchObservationIdentity({ leadId, promptRevisionId: 7, factsHash })).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      deliveryIdempotencyKey({
        projectId,
        promptRevision: 7,
        source: "zumper-com",
        sourceListingId: "listing-1",
        factsHash,
      }),
    ).toMatch(/^v2-[0-9a-f]{64}$/);
  });

  it("distinguishes a materially changed observation", () => {
    expect(matchObservationIdentity({ leadId, promptRevisionId: 7, factsHash })).not.toBe(
      matchObservationIdentity({
        leadId,
        promptRevisionId: 7,
        factsHash: `${factsHash.slice(0, -1)}e`,
      }),
    );
  });

  it("normalizes and validates the closed v2 scope set", () => {
    expect(normalizeV2Scopes(["connection:self", "agent-config:read"])).toEqual([
      "agent-config:read",
      "connection:self",
    ]);
    expect(() => normalizeV2Scopes(["runs:write"])).toThrow(/unknown/);
    expect(() => normalizeV2Scopes([])).toThrow(/non-empty/);
  });
});
