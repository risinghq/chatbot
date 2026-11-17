import { decodeBase64, encodeBase64 } from "@oslojs/encoding";

/**
 * Workers caps PBKDF2 at 100 000 iterations. The count is stored in each hash,
 * so raising it later leaves older hashes verifiable.
 */
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const SCHEME = "pbkdf2-sha256";

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>`, salt and hash in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return [SCHEME, ITERATIONS, encodeBase64(salt), encodeBase64(hash)].join("$");
}

/** False for a wrong password and for a stored value in any other format. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, count, salt, hash] = stored.split("$");
  if (scheme !== SCHEME || !count || !salt || !hash) return false;

  const iterations = Number(count);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  if (iterations > ITERATIONS) return false;

  const decoded = decode(salt, hash);
  if (!decoded) return false;

  const actual = await derive(password, decoded.salt, iterations);
  return (
    actual.length === decoded.hash.length &&
    crypto.subtle.timingSafeEqual(actual, decoded.hash)
  );
}

function decode(
  salt: string,
  hash: string,
): { salt: Uint8Array; hash: Uint8Array } | null {
  try {
    return { salt: decodeBase64(salt), hash: decodeBase64(hash) };
  } catch {
    return null;
  }
}
