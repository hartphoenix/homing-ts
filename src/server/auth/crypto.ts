import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Generate an opaque value suitable for a cookie, bearer token, or device code. */
export function randomOpaque(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new RangeError("opaque value length must be between 16 and 128 bytes");
  }
  return randomBytes(bytes).toString("base64url");
}

/** Persist only this digest. The caller must never log the input. */
export function digestOpaque(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison for already normalized strings. */
export function equalOpaque(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const TOKEN_BYTES = 32;
export const SESSION_COOKIE = "__Host-homing_session";
export const SESSION_DAYS = 14;
export const AGENT_TOKEN_DAYS = 90;
export const DEVICE_LINK_TTL_SECONDS = 600;
export const DEVICE_LINK_INTERVAL_SECONDS = 5;
export const DEVICE_LINK_MAX_POLLS = 400;

export const USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newUserCode(): string {
  const bytes = randomBytes(6);
  let result = "";
  for (let index = 0; index < 6; index += 1) {
    result += USER_CODE_ALPHABET[(bytes[index] ?? 0) % USER_CODE_ALPHABET.length];
  }
  return result;
}

export function normalizeUserCode(value: unknown): string {
  const fixups: Record<string, string> = { I: "1", L: "1", O: "0" };
  const folded = String(value ?? "")
    .toUpperCase()
    .split("")
    .map((character) => fixups[character] ?? character)
    .join("");
  return folded
    .split("")
    .filter((character) => USER_CODE_ALPHABET.includes(character))
    .slice(0, 6)
    .join("");
}
