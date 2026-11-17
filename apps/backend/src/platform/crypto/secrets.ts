/**
 * Access tokens and webhook verify tokens never touch a plaintext column.
 * `channel_secrets` stores AES-256-GCM ciphertext and the channel account keeps
 * only a reference to the row.
 */

import { env } from "cloudflare:workers";
import {
  decodeBase64,
  decodeBase64urlIgnorePadding,
  decodeHex,
  encodeBase64,
  encodeHexLowerCase,
} from "@oslojs/encoding";

const IV_BYTES = 12;

/** `ciphertext` carries the 16-byte GCM tag at its end, as WebCrypto writes it. */
export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  keyId: string;
};

type Key = { key: CryptoKey; id: string };

function parseKey(raw: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return decodeHex(raw);

  for (const decode of [decodeBase64, decodeBase64urlIgnorePadding]) {
    try {
      const decoded = decode(raw);
      if (decoded.length === 32) return decoded;
    } catch {}
  }

  throw new Error(
    "SECRETS_KEY must be 32 bytes encoded as hex (64 chars), base64 or base64url",
  );
}

function rawKey(): Uint8Array {
  const raw = env.SECRETS_KEY;
  if (!raw) {
    throw new Error(
      "SECRETS_KEY is not set; channel credentials cannot be encrypted or read",
    );
  }
  return parseKey(raw);
}

/**
 * Whether a usable key is configured. Callers check it before storing a
 * credential, so they can skip or refuse the write instead of throwing.
 */
export function isEncryptionAvailable(): boolean {
  try {
    rawKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * The key id is a short fingerprint of the key, stored with the ciphertext, so a
 * value encrypted under a retired key is reported as that instead of as a
 * generic authentication failure.
 */
async function readKey(): Promise<Key> {
  const raw = rawKey();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return { key, id: encodeHexLowerCase(digest).slice(0, 16) };
}

export async function encryptSecret(
  plaintext: string,
): Promise<EncryptedValue> {
  const { key, id } = await readKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    iv: encodeBase64(iv),
    keyId: id,
  };
}

export async function decryptSecret(value: EncryptedValue): Promise<string> {
  const { key, id } = await readKey();

  if (value.keyId !== id) {
    throw new Error(
      "Stored secret was encrypted with a different SECRETS_KEY than the one configured",
    );
  }

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(value.iv) },
    key,
    decodeBase64(value.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}
