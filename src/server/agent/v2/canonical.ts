import { createHash } from "node:crypto";

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | {
      [key: string]: CanonicalJson;
    };

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function quote(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError("Strings cannot contain lone UTF-16 surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError("Strings cannot contain lone UTF-16 surrogates");
    }
  }
  // JSON.stringify escapes control characters and quotes, but leaves Unicode code points
  // unescaped, which is the wire format required by the v2 contract.
  return JSON.stringify(value.normalize("NFC"));
}

function encode(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new CanonicalJsonError("Canonical JSON numbers must be finite safe integers");
    }
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "undefined") throw new CanonicalJsonError("undefined is not JSON data");
  if (typeof value === "bigint") throw new CanonicalJsonError("bigint is not JSON data");
  if (typeof value === "function" || typeof value === "symbol") {
    throw new CanonicalJsonError("Functions and symbols are not JSON data");
  }
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(",")}]`;
  if (!isRecord(value)) throw new CanonicalJsonError("Canonical JSON accepts plain objects only");

  const normalizedEntries = new Map<string, unknown>();
  for (const key of Object.keys(value)) normalizedEntries.set(key.normalize("NFC"), value[key]);
  const entries = [...normalizedEntries.entries()]
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([key, item]) => `${quote(key)}:${encode(item)}`);
  return `{${entries.join(",")}}`;
}

function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftCodePoints[index] ?? 0) - (rightCodePoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

/** Serializes v2 JSON with sorted object keys, NFC strings, and no insignificant whitespace. */
export function canonicalizeJson(value: unknown): string {
  return encode(value);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJsonBytes(value));
}

export function parseCanonicalJsonBytes(bytes: Uint8Array): CanonicalJson {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CanonicalJsonError("Canonical JSON bytes must be valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new CanonicalJsonError("Canonical JSON bytes must contain valid JSON");
  }
  if (canonicalizeJson(parsed) !== text) {
    throw new CanonicalJsonError("JSON bytes are not in canonical form");
  }
  return parsed as CanonicalJson;
}

export function assertCanonicalJsonBytes(bytes: Uint8Array, expectedSha256?: string): void {
  parseCanonicalJsonBytes(bytes);
  const actual = sha256Hex(bytes);
  if (expectedSha256 !== undefined && actual !== expectedSha256) {
    throw new CanonicalJsonError("Canonical JSON hash does not match the recorded digest");
  }
}

export function etagForSha256(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new CanonicalJsonError("Invalid SHA-256 digest");
  return `"sha256-${sha256}"`;
}
