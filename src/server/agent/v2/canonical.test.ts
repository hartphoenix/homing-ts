import { describe, expect, it } from "vitest";

import {
  assertCanonicalJsonBytes,
  canonicalizeJson,
  canonicalJsonBytes,
  canonicalJsonSha256,
  etagForSha256,
  parseCanonicalJsonBytes,
} from "./canonical";

describe("v2 canonical JSON", () => {
  it.each([
    [{ b: 2, a: 1 }, '{"a":1,"b":2}'],
    [
      { text: "e\u0301", empty: null, list: [null, 0, true] },
      '{"empty":null,"list":[null,0,true],"text":"é"}',
    ],
    [
      { negativeZero: -0, integer: Number.MAX_SAFE_INTEGER },
      '{"integer":9007199254740991,"negativeZero":0}',
    ],
  ])("canonicalizes %j", (input, expected) => {
    expect(canonicalizeJson(input)).toBe(expected);
    expect(new TextDecoder().decode(canonicalJsonBytes(input))).toBe(expected);
  });

  it.each([
    [1.5, "fractional number"],
    [Number.NaN, "non-finite number"],
    [Number.POSITIVE_INFINITY, "non-finite number"],
    [{ missing: undefined }, "undefined"],
    [new Date(0), "plain objects"],
  ])("rejects %s (%s)", (input, _label) => {
    expect(() => canonicalizeJson(input)).toThrow();
  });

  it("round-trips exact bytes and rejects insignificant whitespace", () => {
    const bytes = canonicalJsonBytes({ value: "✓", nested: { a: null } });
    expect(parseCanonicalJsonBytes(bytes)).toEqual({ value: "✓", nested: { a: null } });
    expect(() =>
      assertCanonicalJsonBytes(new TextEncoder().encode('{ "nested": {"a":null}, "value":"✓" }')),
    ).toThrow(/canonical form/);
  });

  it("uses the exact bytes for the digest and ETag", () => {
    const bytes = canonicalJsonBytes({ a: 1 });
    const digest = canonicalJsonSha256({ a: 1 });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(etagForSha256(digest)).toBe(`"sha256-${digest}"`);
    expect(() => assertCanonicalJsonBytes(bytes, `${digest.slice(0, -1)}0`)).toThrow(/hash/);
  });
});
