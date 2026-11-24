import { Hono } from "hono";
import type {
  ChannelAccount,
  ConversationRef,
  IncomingMessage,
} from "@vendeya/types";
import { ChannelAccountService } from "../domains/channels/accounts.ts";
import { handleInbound, wakeAll } from "../conversation/inbound.ts";
import { lockKey } from "../conversation/locks.ts";
import {
  claimComment,
  replyToComment,
  type InstagramComment,
} from "../domains/instagram/comments.ts";
import { createLogger } from "../lib/logger.ts";
import {
  limitWebhookBody,
  refusalFor,
  signatureFailure,
  verifyHandshake,
} from "./webhook-auth.ts";

const logger = createLogger("instagram-webhook");

const instagramWebhook = new Hono();

instagramWebhook.get("/", verifyHandshake);

type Entry = { id: string; messaging: unknown[]; changes: unknown[] };

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;
const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;

/** The entries of an `object: "instagram"` body, each named by its account id. */
function entriesOf(body: unknown): Entry[] | null {
  const root = obj(body);
  if (root?.object !== "instagram" || !Array.isArray(root.entry)) return null;
  const entries: Entry[] = [];
  for (const raw of root.entry) {
    const entry = obj(raw);
    const id = str(entry?.id);
    if (!entry || !id) return null;
    entries.push({
      id,
      messaging: Array.isArray(entry.messaging) ? entry.messaging : [],
      changes: Array.isArray(entry.changes) ? entry.changes : [],
    });
  }
  return entries;
}

/**
 * A DM as the inbound pipeline takes it, or null for an echo of our own send,
 * a read receipt, a reaction and the like. Only text gets a turn: an
 * attachment arrives as `unknown`, which the pipeline ignores.
 */
export function parseDirectMessage(
  accountId: string,
  raw: unknown,
): IncomingMessage | null {
  const event = obj(raw);
  const message = obj(event?.message);
  const from = str(obj(event?.sender)?.id);
  const mid = str(message?.mid);
  if (!message || !from || !mid) return null;
  if (message.is_echo === true || from === accountId) return null;
  if (message.is_deleted === true) return null;

  const text = str(message.text);
  const replyTo = str(obj(message.reply_to)?.mid);
  const referral = obj(message.referral) ?? obj(event?.referral);
  const adId = str(referral?.ad_id);
  const timestamp =
    typeof event?.timestamp === "number" ? event.timestamp : Date.now();

  return {
    id: mid,
    from,
    body: text ?? "",
    type: text ? "text" : "unknown",
    timestamp,
    ...(replyTo
      ? { quotedContext: { id: replyTo, body: "", type: "text", timestamp: 0 } }
      : {}),
    ...(adId
      ? {
          referral: {
            sourceId: adId,
            headline: str(obj(referral?.ads_context_data)?.ad_title),
            ctwaClid: null,
          },
        }
      : {}),
  };
}

/** A `comments` change, or null for any other field. */
export function parseComment(raw: unknown): InstagramComment | null {
  const change = obj(raw);
  if (change?.field !== "comments") return null;
  const value = obj(change.value);
  const id = str(value?.id);
  const from = obj(value?.from);
  const fromId = str(from?.id);
  if (!value || !id || !fromId) return null;
  return {
    id,
    text: typeof value.text === "string" ? value.text : "",
    fromId,
    fromUsername: str(from?.username),
    mediaId: str(obj(value.media)?.id),
    parentId: str(value.parent_id),
  };
}

/**
 * The account of every entry, once each signature has verified against that
 * account's app secret. Any unknown account or missing secret refuses the
 * whole delivery, as the WhatsApp webhook does.
 */
async function verifiedAccounts(
  entries: Entry[],
  rawBody: string,
  header: string | null,
): Promise<Map<string, ChannelAccount> | null> {
  const accounts = new Map<string, ChannelAccount>();
  for (const { id } of entries) {
    if (accounts.has(id)) continue;
    const account = await ChannelAccountService.getByPhoneNumberId(
      id,
      "instagram",
    );
    const secret = account
      ? await ChannelAccountService.getAppSecret(account)
      : null;
    if (!account || !secret) {
      logger.warn(
        { instagramAccountId: id, known: Boolean(account) },
        "Instagram webhook refused: unknown account or no app secret",
      );
      return null;
    }
    const failure = await signatureFailure(rawBody, header, secret);
    if (failure) {
      logger.warn(
        { reason: failure, instagramAccountId: id },
        "Instagram webhook rejected: bad signature",
      );
      return null;
    }
    accounts.set(id, account);
  }
  return accounts;
}

/**
 * DMs go through the same inbound pipeline as WhatsApp, keyed by the sender's
 * Instagram-scoped id. A comment is claimed before the answer, and its replies
 * run after it.
 */
instagramWebhook.post("/", limitWebhookBody, async (c) => {
  const rawBody = await c.req.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    logger.warn("Instagram webhook refused: body is not JSON");
    return c.json({ error: "invalid_signature" }, 401);
  }

  const entries = entriesOf(parsed);
  if (!entries || entries.length === 0) {
    logger.warn("Instagram webhook refused: body names no Instagram account");
    return c.json({ error: "invalid_signature" }, 401);
  }

  const accounts = await verifiedAccounts(
    entries,
    rawBody,
    c.req.header("X-Hub-Signature-256") ?? null,
  );
  if (!accounts) return c.json({ error: "invalid_signature" }, 401);

  const results: Array<{ accountId: string; status: string }> = [];
  const queued = new Map<string, ConversationRef>();
  let failed = false;

  for (const entry of entries) {
    const account = accounts.get(entry.id)!;
    const refused = await refusalFor(account);
    if (refused) {
      results.push({ accountId: entry.id, status: refused });
      continue;
    }

    for (const raw of entry.messaging) {
      const message = parseDirectMessage(entry.id, raw);
      if (!message) {
        results.push({ accountId: entry.id, status: "ignored" });
        continue;
      }
      try {
        const handled = await handleInbound(account, message);
        results.push({ accountId: entry.id, status: handled.status });
        if (handled.queued) queued.set(lockKey(handled.queued), handled.queued);
      } catch (error) {
        failed = true;
        logger.error(
          { error, messageId: message.id, tenantId: account.tenant_id },
          "Instagram DM processing failed",
        );
        results.push({ accountId: entry.id, status: "error" });
      }
    }

    for (const raw of entry.changes) {
      const comment = parseComment(raw);
      if (!comment) {
        results.push({ accountId: entry.id, status: "ignored" });
        continue;
      }
      try {
        const claimed = await claimComment(account, comment);
        results.push({ accountId: entry.id, status: `comment_${claimed}` });
        if (claimed === "claimed") {
          c.executionCtx.waitUntil(
            replyToComment(account, comment).catch((error: unknown) =>
              logger.error(
                { error, tenantId: account.tenant_id },
                "Replying to an Instagram comment failed",
              ),
            ),
          );
        }
      } catch (error) {
        failed = true;
        logger.error(
          { error, tenantId: account.tenant_id },
          "Instagram comment processing failed",
        );
        results.push({ accountId: entry.id, status: "error" });
      }
    }
  }

  wakeAll(queued.values(), (p) => c.executionCtx.waitUntil(p));

  // Meta redelivers the whole batch after a 5xx. A DM is recognised by its id
  // and a comment by its claim, so nothing is handled twice.
  return failed ? c.json({ results }, 500) : c.json({ results });
});

export default instagramWebhook;
