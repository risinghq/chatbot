/**
 * TAYPI, the Peruvian QR gateway (Yape, Plin and bank apps), with each
 * business's own keys. The keys are stored encrypted in `tenant_secrets` and
 * name their environment: `taypi_pk_test_…` is the sandbox.
 *
 * A merchant TAYPI has not approved for direct QR gets 403 from
 * POST /api/v1/payments, so a charge is a checkout session that the customer
 * pays in TAYPI's checkout.js v2. TAYPI serves that QR only on the domains
 * the merchant registered in its panel.
 */

import { TenantSecrets } from "../settings/tenant-secrets.ts";

export const TAYPI_PUBLIC_KEY = "taypi_public_key";
export const TAYPI_SECRET_KEY = "taypi_secret_key";
export const TAYPI_WEBHOOK_SECRET = "taypi_webhook_secret";

/** TAYPI refuses an amount outside S/ 1.00 to S/ 500.00. */
export const TAYPI_MIN_CENTS = 100;
export const TAYPI_MAX_CENTS = 50_000;

export type TaypiEnvironment = "sandbox" | "production";

export type TaypiKeys = {
  publicKey: string;
  secretKey: string;
  webhookSecret: string;
};

const PUBLIC_KEY = /^taypi_pk_(test|live)_[0-9a-f]{32}$/;
const SECRET_KEY = /^taypi_sk_(test|live)_[0-9a-f]{64}$/;

export function taypiEnvironment(publicKey: string): TaypiEnvironment {
  return publicKey.startsWith("taypi_pk_test_") ? "sandbox" : "production";
}

function baseUrl(environment: TaypiEnvironment): string {
  return environment === "sandbox"
    ? "https://sandbox.taypi.pe"
    : "https://app.taypi.pe";
}

/** The checkout.js v2 script the pay page loads. */
export function taypiCheckoutScript(environment: TaypiEnvironment): string {
  return `${baseUrl(environment)}/v2/checkout.js`;
}

/**
 * The keys from a settings form, or why they are refused. Both API keys must
 * be from the same environment: a live secret signs nothing a test key opens.
 */
export function parseTaypiKeys(
  body: Record<string, unknown>,
): TaypiKeys | string {
  const publicKey = String(body.public_key ?? "").trim();
  const secretKey = String(body.secret_key ?? "").trim();
  const webhookSecret = String(body.webhook_secret ?? "").trim();
  const pk = PUBLIC_KEY.exec(publicKey);
  const sk = SECRET_KEY.exec(secretKey);
  if (!pk)
    return "La clave pública empieza con taypi_pk_test_ o taypi_pk_live_";
  if (!sk)
    return "La clave secreta empieza con taypi_sk_test_ o taypi_sk_live_";
  if (pk[1] !== sk[1]) {
    return "Las dos claves deben ser del mismo entorno: prueba o producción";
  }
  if (webhookSecret.length < 16) {
    return "Copia el secreto del webhook completo desde el panel de TAYPI";
  }
  return { publicKey, secretKey, webhookSecret };
}

/** The business's keys, or null while any of them is missing or unreadable. */
export async function taypiKeys(tenantId: string): Promise<TaypiKeys | null> {
  const [publicKey, secretKey, webhookSecret] = await Promise.all([
    TenantSecrets.get(tenantId, TAYPI_PUBLIC_KEY),
    TenantSecrets.get(tenantId, TAYPI_SECRET_KEY),
    TenantSecrets.get(tenantId, TAYPI_WEBHOOK_SECRET),
  ]);
  if (!publicKey || !secretKey || !webhookSecret) return null;
  return { publicKey, secretKey, webhookSecret };
}

export async function saveTaypiKeys(
  tenantId: string,
  keys: TaypiKeys,
): Promise<void> {
  await TenantSecrets.set(tenantId, TAYPI_PUBLIC_KEY, keys.publicKey);
  await TenantSecrets.set(tenantId, TAYPI_SECRET_KEY, keys.secretKey);
  await TenantSecrets.set(tenantId, TAYPI_WEBHOOK_SECRET, keys.webhookSecret);
}

export async function clearTaypiKeys(tenantId: string): Promise<void> {
  await TenantSecrets.clear(tenantId, TAYPI_PUBLIC_KEY);
  await TenantSecrets.clear(tenantId, TAYPI_SECRET_KEY);
  await TenantSecrets.clear(tenantId, TAYPI_WEBHOOK_SECRET);
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A TAYPI answer other than 2xx, with its error code when it gave one. */
export class TaypiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One signed API call. TAYPI checks
 * HMAC-SHA256(secret, "timestamp\nMETHOD\npath\nbody") against the
 * `Taypi-Signature` header, so the path signed is the one sent, query included.
 */
async function call<T>(
  keys: TaypiKeys,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    authorization: `Bearer ${keys.publicKey}`,
    accept: "application/json",
    "taypi-timestamp": timestamp,
    "taypi-signature": await hmacHex(
      keys.secretKey,
      `${timestamp}\n${method}\n${path}\n${text}`,
    ),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  const response = await fetch(
    `${baseUrl(taypiEnvironment(keys.publicKey))}${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : text,
      signal: AbortSignal.timeout(10_000),
    },
  );
  const json = (await response.json().catch(() => null)) as {
    data?: T;
    error?: string;
    message?: string;
  } | null;
  if (!response.ok) {
    throw new TaypiError(
      response.status,
      json?.error ?? null,
      json?.message ?? `TAYPI answered ${response.status}`,
    );
  }
  return json?.data as T;
}

/** "150.00" from 15000, the amount format TAYPI takes and sends. */
export function taypiAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function centsFromTaypiAmount(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

export const TaypiApi = {
  /** The merchant the keys belong to. Saving keys checks them with this. */
  merchant: (keys: TaypiKeys) =>
    call<{ business_name: string; webhook_url: string | null }>(
      keys,
      "GET",
      "/api/v1/merchant",
    ),

  /**
   * Opens a checkout session. `reference` comes back in the webhook, and as
   * the idempotency key a retry opens the same session.
   */
  createCheckoutSession: (
    keys: TaypiKeys,
    input: {
      reference: string;
      amountCents: number;
      description: string;
      expiresInMinutes: number;
    },
  ) =>
    call<{ checkout_token: string }>(
      keys,
      "POST",
      "/v1/checkout/sessions",
      {
        amount: taypiAmount(input.amountCents),
        reference: input.reference,
        description: input.description.slice(0, 255),
        expires_in: input.expiresInMinutes,
      },
      input.reference,
    ),

  /** The payments made under our reference, newest first. */
  paymentsByReference: (keys: TaypiKeys, reference: string) =>
    call<TaypiPayment[]>(
      keys,
      "GET",
      `/api/v1/payments?reference=${encodeURIComponent(reference)}`,
    ),
};

/** A payment as the list and the webhook give it. */
export type TaypiPayment = {
  payment_id: string;
  status: string;
  amount: string;
  reference: string | null;
  payer_display_name?: string | null;
};

const SIGNATURE_PREFIX = "sha256=";

/**
 * True when `Taypi-Signature: sha256=<hex>` is HMAC-SHA256 of the raw body
 * under the webhook secret. The comparison runs in constant time.
 */
export async function taypiSignatureMatches(
  rawBody: string,
  header: string | null,
  webhookSecret: string,
): Promise<boolean> {
  if (!header?.startsWith(SIGNATURE_PREFIX)) return false;
  const given = encoder.encode(
    header.slice(SIGNATURE_PREFIX.length).toLowerCase(),
  );
  const expected = encoder.encode(await hmacHex(webhookSecret, rawBody));
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}
