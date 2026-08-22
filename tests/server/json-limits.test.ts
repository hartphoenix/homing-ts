import { describe, expect, it } from "vitest";
import { isBoundedJson } from "../../src/server/json-limits";

describe("structured JSON limits", () => {
  it("accepts normal search criteria and rejects depth, node, and byte excess", () => {
    expect(isBoundedJson({ boroughs: ["Brooklyn", "Queens"], price: { max: 4_000 } })).toBe(true);
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 10; depth += 1) nested = { child: nested };
    expect(isBoundedJson(nested)).toBe(false);
    expect(isBoundedJson({ items: Array.from({ length: 2_001 }, () => null) })).toBe(false);
    expect(isBoundedJson({ text: "x".repeat(50_001) })).toBe(false);
  });
});
