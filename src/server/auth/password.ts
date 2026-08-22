import { pbkdf2Sync, timingSafeEqual } from "node:crypto";

export type PasswordCheck = {
  valid: boolean;
  /** A successful legacy check supplies a native hash for transactional rehash. */
  rehash?: string;
};

const ARGON2_WRAPPER =
  /^argon2\$(argon2(?:id|i)\$v=19\$m=\d{1,7},t=\d{1,5},p=\d{1,4}\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2})$/;
const PBKDF2_FORMAT = /^pbkdf2_sha256\$(\d{4,10})\$([^$]{1,128})\$([A-Za-z0-9+/]+={0,2})$/;

function decodeDjangoBase64(value: string): Buffer | null {
  try {
    const normalized = value + "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = Buffer.from(normalized, "base64");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

async function nativeHash(password: string): Promise<string> {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 2,
  });
}

export async function hashPassword(password: string): Promise<string> {
  return nativeHash(password);
}

/** Verify a Django-exported Argon2 or PBKDF2-SHA256 password without exposing its hash. */
export async function verifyImportedPassword(
  password: string,
  encoded: string,
): Promise<PasswordCheck> {
  const argon = ARGON2_WRAPPER.exec(encoded);
  if (argon) {
    const phc = argon[1];
    if (!phc) return { valid: false };
    try {
      // Django omits the leading PHC `$` after its `argon2` algorithm wrapper.
      const valid = await Bun.password.verify(password, `$${phc}`);
      if (!valid) return { valid: false };
      try {
        return { valid: true, rehash: await nativeHash(password) };
      } catch {
        return { valid: true };
      }
    } catch {
      return { valid: false };
    }
  }

  const pbkdf2 = PBKDF2_FORMAT.exec(encoded);
  if (!pbkdf2) return { valid: false };
  const iterationText = pbkdf2[1];
  const salt = pbkdf2[2];
  const digest = pbkdf2[3];
  if (!iterationText || !salt || !digest) return { valid: false };
  const iterations = Number(iterationText);
  const expected = decodeDjangoBase64(digest);
  if (!Number.isSafeInteger(iterations) || iterations < 1_000 || !expected) {
    return { valid: false };
  }
  try {
    const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
    const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!valid) return { valid: false };
    try {
      return { valid: true, rehash: await nativeHash(password) };
    } catch {
      return { valid: true };
    }
  } catch {
    return { valid: false };
  }
}

/** Verify either a native Bun Argon2 hash or one of the supported Django formats. */
export async function verifyPassword(password: string, encoded: string): Promise<PasswordCheck> {
  if (isSupportedImportedHash(encoded)) return verifyImportedPassword(password, encoded);
  try {
    const valid = await Bun.password.verify(password, encoded);
    return { valid };
  } catch {
    return { valid: false };
  }
}

export function isSupportedImportedHash(encoded: string): boolean {
  return ARGON2_WRAPPER.test(encoded) || PBKDF2_FORMAT.test(encoded);
}
