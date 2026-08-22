import { cursorExpired, validation } from "./errors";

const EPOCH_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SEQUENCE_RE = /^(0|[1-9][0-9]*)$/;

/** The cursor is opaque to clients, but deliberately self-describing for safe migration. */
export function formatChangeCursor(feedEpoch: string, sequence: number | bigint): string {
  if (!EPOCH_RE.test(feedEpoch)) {
    throw validation("feed epoch is invalid");
  }
  const value = typeof sequence === "bigint" ? sequence.toString() : String(sequence);
  if (!SEQUENCE_RE.test(value) || BigInt(value) < 0n) {
    throw validation("change sequence is invalid");
  }
  return `${feedEpoch}:${value}`;
}

export type ParsedChangeCursor = { feedEpoch: string; sequence: bigint };

/**
 * Parse a cursor for a particular project's epoch. Empty cursors are the fresh-feed cursor.
 * Numeric and otherwise well-shaped cursors from an older deployment intentionally expire.
 */
export function parseChangeCursor(
  raw: string | null | undefined,
  feedEpoch: string,
): ParsedChangeCursor {
  if (!EPOCH_RE.test(feedEpoch)) {
    throw validation("feed epoch is invalid");
  }
  if (raw === undefined || raw === null || raw === "") {
    return { feedEpoch, sequence: 0n };
  }
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    throw cursorExpired();
  }
  const candidateEpoch = raw.slice(0, separator);
  const candidateSequence = raw.slice(separator + 1);
  if (!EPOCH_RE.test(candidateEpoch) || !SEQUENCE_RE.test(candidateSequence)) {
    throw cursorExpired();
  }
  if (candidateEpoch !== feedEpoch) {
    throw cursorExpired();
  }
  return { feedEpoch: candidateEpoch, sequence: BigInt(candidateSequence) };
}
