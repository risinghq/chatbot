/**
 * Web Push transport: a POST to the subscription's endpoint with the payload
 * encrypted as aes128gcm (RFC 8291, RFC 8188) and a VAPID-signed Authorization
 * header (RFC 8292). Everything runs on Web Crypto; there is no Node crypto on
 * the Workers runtime.
 */

import { env } from "cloudflare:workers";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger("push");

export type PushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushPayload = {
  title: string;
  body: string;
  /** The dashboard path a click opens. */
  url?: string;
};

export type PushOutcome = "sent" | "gone" | "failed";

export function base64Url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * The VAPID JWT: ES256 over {aud, exp, sub}. `aud` is the push service's
 * origin, `sub` the operator contact, `exp` at most 24 h out.
 */
// VAPID_PRIVATE_KEY is an optional secret, so it is not in Env's generated
// types.
const vapidPrivateKey = () =>
  (env as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY ?? "";

async function vapidJwt(endpoint: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64Url(vapidPrivateKey()) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const encode = (value: object) =>
    base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT,
  })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(signature)}`;
}

/** Encrypts the payload into the single aes128gcm record the body carries. */
async function encryptPayload(
  subscription: PushSubscription,
  data: Uint8Array,
): Promise<Uint8Array> {
  const uaPublic = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);

  const local = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer,
  );
  const remote = await crypto.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      // The runtime reads "public"; workerd's types spell it $public.
      { name: "ECDH", public: remote } as SubtleCryptoDeriveKeyAlgorithm,
      local.privateKey,
      256,
    ),
  );

  const encoder = new TextEncoder();
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(
      encoder.encode("WebPush: info"),
      new Uint8Array([0]),
      uaPublic,
      asPublic,
    ),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  // The last record's delimiter byte ends the plaintext; no padding follows.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aesKey,
      concat(data, new Uint8Array([2])) as BufferSource,
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(
    salt,
    recordSize,
    new Uint8Array([asPublic.length]),
    asPublic,
    ciphertext,
  );
}

/**
 * Sends one notification. `gone` means the service reported the subscription
 * dead (404 or 410) and the caller should drop its row.
 */
export async function sendPushNotification(
  subscription: PushSubscription,
  payload: PushPayload,
): Promise<PushOutcome> {
  if (!env.VAPID_PUBLIC_KEY || !vapidPrivateKey() || !env.VAPID_SUBJECT) {
    logger.warn(
      { endpoint: subscription.endpoint },
      "VAPID is not configured; push cannot be sent",
    );
    return "failed";
  }

  let body: Uint8Array;
  let jwt: string;
  try {
    body = await encryptPayload(
      subscription,
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    jwt = await vapidJwt(subscription.endpoint);
  } catch (error) {
    logger.error(
      { error, endpoint: subscription.endpoint },
      "Push encryption failed",
    );
    return "failed";
  }

  try {
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "3600",
        Urgency: "high",
      },
      body: body as unknown as ArrayBuffer,
    });

    if (response.status === 404 || response.status === 410) return "gone";
    if (response.status >= 200 && response.status < 300) return "sent";

    logger.warn(
      { status: response.status, endpoint: subscription.endpoint },
      "Push service refused the notification",
    );
    return "failed";
  } catch (error) {
    logger.error(
      { error, endpoint: subscription.endpoint },
      "Push send failed",
    );
    return "failed";
  }
}
