import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { decodeHex } from "@oslojs/encoding";
import type { ChannelAccount } from "@vendeya/types";
import { ChannelAccountService } from "../domains/channels/accounts.ts";
import { TenantService } from "../domains/tenants/index.ts";
import { createLogger } from "../lib/logger.ts";

const logger = createLogger("webhook");

// Meta documents webhook payloads of up to 3 MB.
const MAX_WEBHOOK_BODY_BYTES = 3 * 1024 * 1024;

// `bodyLimit` counts the bytes of a chunked body that has no Content-Length.
// A route runs it ahead of the signature check because the endpoint is public.
export const limitWebhookBody = bodyLimit({
  maxSize: MAX_WEBHOOK_BODY_BYTES,
  onError: (c) => {
    logger.warn("Webhook POST rejected: body over the size limit");
    return c.json({ error: "payload_too_large" }, 413);
  },
});

const encoder = new TextEncoder();

function constantTimeEquals(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

/**
 * Meta's verification handshake carries no account id, so the token is the
 * only thing identifying the caller. Any channel account whose generated
 * verify token matches answers the challenge.
 */
async function verifyTokenMatches(
  token: string,
): Promise<ChannelAccount | null> {
  for (const account of await ChannelAccountService.listWithVerifyToken()) {
    const stored = await ChannelAccountService.getVerifyToken(account);
    if (stored && constantTimeEquals(stored, token)) {
      return account;
    }
  }
  return null;
}

/** Answers Meta's GET subscription handshake. */
export async function verifyHandshake(c: Context) {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode !== "subscribe" || !token) {
    return c.text("Forbidden", 403);
  }

  const match = await verifyTokenMatches(token);
  if (!match) {
    logger.warn("Webhook verification rejected: no matching verify token");
    return c.text("Forbidden", 403);
  }

  logger.info({ channelAccountId: match.id }, "Webhook verification succeeded");
  return c.text(challenge || "");
}

const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_LENGTH = SIGNATURE_PREFIX.length + 64;
const HEX_DIGEST = /^[0-9a-f]+$/;

/**
 * Why a signature header was refused, or null when it matches the raw body.
 * `crypto.subtle.verify` compares the MAC in constant time.
 */
export async function signatureFailure(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<string | null> {
  if (!header) return "missing_header";
  if (!header.startsWith(SIGNATURE_PREFIX)) return "bad_prefix";
  if (header.length !== SIGNATURE_LENGTH) return "bad_length";
  const digest = header.slice(SIGNATURE_PREFIX.length);
  if (!HEX_DIGEST.test(digest)) return "non_hex";

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    decodeHex(digest),
    encoder.encode(rawBody),
  );
  return valid ? null : "mismatch";
}

/**
 * Why an account may not answer, or null when it may. `pending` matters as
 * much as `disabled`: the send side refuses anything but an active account, so
 * accepting a message would leave the customer waiting on a reply that can
 * never be sent. A suspended business's bot stops answering too.
 */
export async function refusalFor(
  account: ChannelAccount,
): Promise<string | null> {
  if (account.status !== "active") {
    logger.warn(
      {
        channelAccountId: account.id,
        tenantId: account.tenant_id,
        status: account.status,
      },
      "Inbound event for a channel account that is not active",
    );
    return `channel_account_${account.status}`;
  }

  const tenant = await TenantService.getById(account.tenant_id);
  if (tenant?.status !== "active") {
    logger.warn(
      {
        channelAccountId: account.id,
        tenantId: account.tenant_id,
        tenantStatus: tenant?.status ?? "missing",
      },
      "Inbound event for a tenant that is not active",
    );
    return "tenant_not_active";
  }
  return null;
}
