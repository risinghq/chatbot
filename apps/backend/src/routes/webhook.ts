import { Hono } from "hono";
import type { ChannelAccount, ConversationRef } from "@vendeya/types";
import { ChannelAccountService } from "../domains/channels/accounts.ts";
import { handleInbound, wakeAll } from "../conversation/inbound.ts";
import { lockKey } from "../conversation/locks.ts";
import { TemplateService } from "../domains/campaigns/templates.ts";
import { db, withoutTenantScope } from "../db/index.ts";
import { sql } from "kysely";
import type {
  InboundRouting,
  ParsedChange,
} from "../adapters/whatsapp/parsers/index.ts";
import { parseWebhookBody } from "../adapters/whatsapp/parsers/index.ts";
import { createLogger } from "../lib/logger.ts";
import {
  limitWebhookBody,
  refusalFor,
  signatureFailure,
  verifyHandshake,
} from "./webhook-auth.ts";

const logger = createLogger("webhook");

const webhook = new Hono();

webhook.get("/", verifyHandshake);

/**
 * The phone_number_id every change's metadata names. Read before the body is
 * fully parsed: the signature can be checked only against the app secret of
 * the channel each number belongs to.
 */
function phoneNumberIdsOf(body: unknown): Set<string> {
  const ids = new Set<string>();
  if (typeof body !== "object" || body === null) return ids;

  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return ids;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const metadata = (change as { value?: { metadata?: unknown } })?.value
        ?.metadata;
      const id = (metadata as { phone_number_id?: unknown })?.phone_number_id;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return ids;
}

/**
 * The WABA ids of entries whose changes name no phone_number_id, such as a
 * `message_template_status_update`. Meta signs them with the same app secret
 * as the WABA's number, so the account is resolved by `entry.id`.
 */
function wabaIdsOf(body: unknown): Set<string> {
  const ids = new Set<string>();
  if (typeof body !== "object" || body === null) return ids;

  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return ids;

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes) || changes.length === 0) continue;
    const hasNumber = changes.some(
      (change) =>
        (change as { value?: { metadata?: { phone_number_id?: unknown } } })
          ?.value?.metadata?.phone_number_id,
    );
    const id = (entry as { id?: unknown }).id;
    if (!hasNumber && typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

/**
 * The `message_template_status_update` changes in a body: Meta reports a
 * template's review as `event` on the WABA entry. `statuses` carries Meta's
 * delivery statuses for messages we sent (sent, delivered, read, failed).
 */
function nonMessageChangesOf(body: unknown): {
  templateUpdates: { wabaId: string | null; value: Record<string, unknown> }[];
  statuses: { phoneNumberId: string | null; value: Record<string, unknown> }[];
} {
  const templateUpdates: {
    wabaId: string | null;
    value: Record<string, unknown>;
  }[] = [];
  const statuses: {
    phoneNumberId: string | null;
    value: Record<string, unknown>;
  }[] = [];
  if (typeof body !== "object" || body === null)
    return { templateUpdates, statuses };

  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return { templateUpdates, statuses };

  for (const entry of entries) {
    const wabaId =
      typeof (entry as { id?: unknown }).id === "string"
        ? (entry as { id: string }).id
        : null;
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const field = (change as { field?: unknown })?.field;
      const value = (change as { value?: unknown })?.value;
      if (typeof value !== "object" || value === null) continue;
      if (field === "message_template_status_update") {
        templateUpdates.push({
          wabaId,
          value: value as Record<string, unknown>,
        });
      } else if (field === "messages") {
        const list = (value as { statuses?: unknown }).statuses;
        if (!Array.isArray(list)) continue;
        const phoneNumberId = (
          value as { metadata?: { phone_number_id?: unknown } }
        ).metadata?.phone_number_id;
        for (const status of list) {
          if (typeof status === "object" && status !== null) {
            statuses.push({
              phoneNumberId:
                typeof phoneNumberId === "string" ? phoneNumberId : null,
              value: status as Record<string, unknown>,
            });
          }
        }
      }
    }
  }
  return { templateUpdates, statuses };
}

/**
 * The app secrets the signature must satisfy: one per channel the body
 * addresses, or why the delivery is refused. Meta retries a 5xx, so an
 * unsigned or unverifiable delivery is a 401 even though the cause is a
 * missing secret on our side.
 */
async function appSecretsFor(
  ids: Set<string>,
  wabaIds: Set<string> = new Set(),
): Promise<{ secrets: Map<string, string> } | { refused: string }> {
  const secrets = new Map<string, string>();
  const addFor = async (
    key: string,
    account: ChannelAccount | null,
  ): Promise<string | null> => {
    if (!account) return "unknown_channel_account";
    const secret = await ChannelAccountService.getAppSecret(account);
    if (!secret) return "no_app_secret";
    secrets.set(key, secret);
    return null;
  };
  for (const id of ids) {
    const account = await ChannelAccountService.getByPhoneNumberId(id);
    if (!account) {
      logger.warn(
        { phoneNumberId: id },
        "Webhook POST refused: unknown channel account",
      );
      return { refused: "unknown_channel_account" };
    }
    const refused = await addFor(id, account);
    if (refused) {
      logger.warn(
        { phoneNumberId: id, channelAccountId: account.id },
        "Webhook POST refused: channel account has no app secret",
      );
      return { refused };
    }
  }
  for (const id of wabaIds) {
    const account = await ChannelAccountService.getByWabaId(id);
    if (!account) {
      logger.warn({ wabaId: id }, "Webhook POST refused: unknown WABA");
      return { refused: "unknown_channel_account" };
    }
    const refused = await addFor(id, account);
    if (refused) {
      logger.warn(
        { wabaId: id, channelAccountId: account.id },
        "Webhook POST refused: channel account has no app secret",
      );
      return { refused };
    }
  }
  return { secrets };
}

/**
 * Where a change's messages are meant to go, or why they go nowhere. Resolving
 * happens once per change: every message in it arrived on the same number.
 */
type Target = { account: ChannelAccount } | { rejected: string };

async function resolveTarget(routing: InboundRouting): Promise<Target> {
  if (!routing.phoneNumberId) {
    logger.warn(
      { wabaId: routing.wabaId },
      "Webhook payload carries no metadata.phone_number_id",
    );
    return { rejected: "unroutable_no_phone_number_id" };
  }

  const account = await ChannelAccountService.getByPhoneNumberId(
    routing.phoneNumberId,
  );

  if (!account) {
    // Deliveries for numbers we do not host are dropped, not errored: Meta
    // retries 5xx responses and there is nothing to retry into.
    logger.warn(
      { phoneNumberId: routing.phoneNumberId, wabaId: routing.wabaId },
      "Inbound message for unknown channel account",
    );
    return { rejected: "unknown_channel_account" };
  }

  const refused = await refusalFor(account);
  return refused ? { rejected: refused } : { account };
}

/**
 * Ranks Meta's delivery statuses so a later webhook only moves a recipient
 * forward: queued < sent < delivered < read. `failed` outranks everything but
 * a terminal state, matching Meta, which reports a failed send at any stage.
 */
const STATUS_RANK = `CASE status
  WHEN 'pending' THEN 0 WHEN 'queued' THEN 1 WHEN 'sent' THEN 2
  WHEN 'delivered' THEN 3 WHEN 'read' THEN 4
  WHEN 'skipped' THEN 5 WHEN 'failed' THEN 5 END`;
const NEW_STATUS_RANK: Record<string, number> = {
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
};

/**
 * A Meta delivery status names the WhatsApp message id the send response
 * gave, which the `messages` row of the campaign send holds. The campaign's
 * recipient row moves to the new status when it outranks the current one.
 */
async function recordDeliveryStatus(
  whatsappMessageId: string,
  status: string,
): Promise<void> {
  const rank = NEW_STATUS_RANK[status];
  if (rank === undefined) return;

  const message = await withoutTenantScope(
    "Meta's delivery status names a WhatsApp message id",
  )
    .selectFrom("messages")
    .select(["id", "tenant_id"])
    .where("whatsapp_message_id", "=", whatsappMessageId)
    .executeTakeFirst();
  if (!message) return;

  await db
    .updateTable("campaign_recipients")
    .set("status", status as never)
    .where("tenant_id", "=", message.tenant_id)
    .where("message_id", "=", message.id)
    .where(sql`${sql.raw(STATUS_RANK)}`, "<", rank)
    .execute();
}

/**
 * One POST, any number of messages. Each is routed and handled on its own
 * account so that a batch spanning two tenants delivers both, and so that one
 * failure cannot swallow the rest of the payload. A message is stored before
 * the answer, so a 200 means it is durable. The turn runs after the answer, in
 * the conversation's object.
 */
webhook.post("/", limitWebhookBody, async (c) => {
  const rawBody = await c.req.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    logger.warn("Webhook POST refused: body is not JSON");
    return c.json({ error: "invalid_signature" }, 401);
  }

  // The signature is checked against the app secret of every channel the
  // body addresses, before any message is read. A delivery naming numbers
  // on more than one channel must verify against each of them; one naming
  // none has no secret to check against and is refused like a bad signature.
  const phoneNumberIds = phoneNumberIdsOf(parsed);
  const wabaIds = wabaIdsOf(parsed);
  if (phoneNumberIds.size === 0 && wabaIds.size === 0) {
    logger.warn("Webhook POST refused: body names no phone_number_id or WABA");
    return c.json({ error: "invalid_signature" }, 401);
  }

  const resolved = await appSecretsFor(phoneNumberIds, wabaIds);
  if ("refused" in resolved) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  const header = c.req.header("X-Hub-Signature-256") ?? null;
  for (const [phoneNumberId, secret] of resolved.secrets) {
    const failure = await signatureFailure(rawBody, header, secret);
    if (failure) {
      logger.warn(
        { reason: failure, phoneNumberId },
        "Webhook POST rejected: bad signature",
      );
      return c.json({ error: "invalid_signature" }, 401);
    }
  }

  let changes: ParsedChange[];

  try {
    changes = parseWebhookBody(parsed);
  } catch (error) {
    logger.error({ error }, "Webhook body could not be parsed");
    return c.json({ error: "invalid_payload" }, 400);
  }

  const results: Array<{ phoneNumberId: string | null; status: string }> = [];
  const queued = new Map<string, ConversationRef>();
  let failed = false;

  for (const { routing, messages } of changes) {
    const phoneNumberId = routing.phoneNumberId;

    if (messages.length === 0) {
      results.push({ phoneNumberId, status: "no_message" });
      continue;
    }

    const target = await resolveTarget(routing);

    if ("rejected" in target) {
      for (const _message of messages) {
        results.push({ phoneNumberId, status: target.rejected });
      }
      continue;
    }

    for (const message of messages) {
      try {
        const handled = await handleInbound(target.account, message);
        results.push({ phoneNumberId, status: handled.status });
        if (handled.queued) queued.set(lockKey(handled.queued), handled.queued);
      } catch (error) {
        failed = true;
        logger.error(
          {
            error,
            phoneNumber: message.from,
            messageId: message.id,
            tenantId: target.account.tenant_id,
          },
          "Webhook processing failed",
        );
        results.push({ phoneNumberId, status: "error" });
      }
    }
  }

  // A template review and a delivery status carry no inbound message, so the
  // parser drops them; they are applied from the raw body here.
  const { templateUpdates, statuses } = nonMessageChangesOf(parsed);
  for (const { wabaId, value } of templateUpdates) {
    const account = wabaId
      ? await ChannelAccountService.getByWabaId(wabaId)
      : null;
    if (!account) continue;
    await TemplateService.applyStatus(
      account.tenant_id,
      typeof value.message_template_id === "string"
        ? value.message_template_id
        : null,
      typeof value.message_template_name === "string"
        ? value.message_template_name
        : null,
      typeof value.event === "string" ? value.event : "",
      typeof value.reason === "string" ? value.reason : null,
    );
  }
  for (const { value } of statuses) {
    if (typeof value.id !== "string" || typeof value.status !== "string")
      continue;
    await recordDeliveryStatus(value.id, value.status);
  }

  wakeAll(queued.values(), (p) => c.executionCtx.waitUntil(p));

  // Meta redelivers the whole batch after a 5xx, so the messages that did land
  // come back with it. `handleInbound` recognises them by id and skips them.
  return failed ? c.json({ results }, 500) : c.json({ results });
});

export default webhook;
