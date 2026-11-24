import type {
  ChannelAccount,
  ConversationRef,
  IncomingMessage,
} from "@vendeya/types";
import { WhatsAppService } from "../adapters/whatsapp/index.ts";
import { recordAd } from "../domains/ads/index.ts";
import { ATTRIBUTION_DAYS } from "../domains/campaigns/campaigns.ts";
import { db } from "../db/index.ts";
import { createLogger } from "../lib/logger.ts";
import { isQueued, storeIncomingMessage } from "./message-inbox.ts";
import { ensureConversation } from "./store.ts";
import { conversationStub } from "./stub.ts";

const logger = createLogger("webhook");

/**
 * Handle one message on the account it arrived on. Returns what became of it,
 * and the conversation to wake when it was queued.
 */
export async function handleInbound(
  account: ChannelAccount,
  message: IncomingMessage,
): Promise<{ status: string; queued?: ConversationRef }> {
  const phoneNumber = message.from;

  if (!phoneNumber || phoneNumber === "0") {
    return { status: "ignored_system_message" };
  }

  // Meta redelivers an entire batch when the response is a 5xx, so a message
  // that already landed can arrive again next to one that did not. Its id is
  // the key on the queue, and seeing it again means there is nothing to do.
  if (await isQueued(message.id)) {
    return { status: "duplicate" };
  }

  const ref: ConversationRef = {
    tenantId: account.tenant_id,
    channelAccountId: account.id,
    phoneNumber,
  };

  if (message.quotedContext) {
    const quotedMessageContent = await WhatsAppService.getMessageById(
      ref,
      message.quotedContext.id,
    );
    if (quotedMessageContent) {
      message.quotedContext.body = quotedMessageContent.content;
      message.quotedContext.type = quotedMessageContent.type;
      message.quotedContext.timestamp = new Date(
        quotedMessageContent.created_at,
      ).getTime();
    }

    logger.info(
      {
        tenantId: ref.tenantId,
        messageId: message.id,
        from: phoneNumber,
        quotedMessage: message.quotedContext,
      },
      "Quoted message received",
    );
  }

  // A reaction, sticker or contact card asks nothing, so it gets no turn.
  if (message.type === "unknown") {
    logger.info(
      { tenantId: account.tenant_id, messageId: message.id },
      "Ignoring a message type with no text to answer",
    );
    return { status: "unsupported_ignored" };
  }

  if (message.quotedContext) {
    const quotedProductId = await WhatsAppService.findProductByQuotedMessage(
      ref,
      message.quotedContext.id,
    );
    if (quotedProductId) {
      logger.info(
        {
          tenantId: ref.tenantId,
          messageId: message.id,
          quotedMessageId: message.quotedContext.id,
          quotedProductId,
        },
        "Resolved product from quoted message",
      );
    }
  }

  // The message row belongs to a conversation, so the conversation has to
  // exist before it is written. Inbound text from a contact starts one, and the
  // handler's own get-or-create later is idempotent.
  await ensureConversation(ref);

  // An ad click becomes the conversation's latest ad. Orders filed inside the
  // window from now record it.
  if (message.referral) {
    await recordAd(ref, message.referral, message.timestamp);
  }

  await WhatsAppService.logMessage(
    ref,
    "inbound",
    "text",
    message.body,
    "received",
  );

  await storeIncomingMessage(ref, message);

  // A write from a campaign contact counts as its reply, however it comes in.
  // Only sends inside the attribution window — an old campaign does not earn
  // a reply it had no part in.
  await db
    .updateTable("campaign_recipients")
    .set("replied_at", Date.now())
    .where("tenant_id", "=", ref.tenantId)
    .where("phone_number", "=", phoneNumber)
    .where("replied_at", "is", null)
    .where("status", "in", ["queued", "sent", "delivered", "read"])
    .where(
      "queued_at",
      ">=",
      Date.now() - ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000,
    )
    .execute();

  return { status: "received", queued: ref };
}

/** Starts each queued conversation's turn after the webhook has answered. */
export function wakeAll(
  refs: Iterable<ConversationRef>,
  waitUntil: (promise: Promise<unknown>) => void,
): void {
  for (const ref of refs) {
    waitUntil(
      conversationStub(ref)
        .wake(ref)
        .catch((error: unknown) =>
          logger.error(
            {
              error,
              tenantId: ref.tenantId,
              channelAccountId: ref.channelAccountId,
            },
            "Waking the conversation failed; the sweep wakes it",
          ),
        ),
    );
  }
}
