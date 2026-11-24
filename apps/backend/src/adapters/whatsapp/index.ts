import type { ChannelAccount, ConversationRef } from "@vendeya/types";
import type {
  ConversationMessage,
  OutboundMessage,
  SendOutcome,
  SendResult,
  StoredMessageType,
} from "./types.ts";
import { CloudApiAdapter } from "./cloud-api.ts";
import { InstagramAdapter, type InstagramWindow } from "../instagram/api.ts";
import { MessageStore } from "./message-store.ts";
import { ChannelAccountService } from "../../domains/channels/accounts.ts";
import { TenantService } from "../../domains/tenants/index.ts";
import {
  enqueue,
  hasQueuedReply,
  queuedBehind,
  stepOutbox,
} from "../../conversation/outbox.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger("whatsapp");

const adapter = CloudApiAdapter;

/**
 * Thrown when a send targets a `pending` or `disabled` channel account of an
 * open tenant. The aggregator leaves the inbox row pending, so switching a
 * number off pauses its conversations.
 */
export class ChannelUnavailableError extends Error {
  constructor(
    readonly ref: ConversationRef,
    readonly status: ChannelAccount["status"],
  ) {
    super(
      `Channel account ${ref.channelAccountId} is ${status}, not active: nothing was sent`,
    );
    this.name = "ChannelUnavailableError";
  }
}

/**
 * `unsendable` holds the account when its tenant is open and the ref matches it,
 * but the account is not active. The caller turns that into a throw. It is null
 * for a permanent refusal (suspended tenant, missing account, ref built from two
 * tenants), which is logged and returned as a `permanent` outcome with `reason`.
 * `recordable` is false when the ref names no conversation. `messages` and
 * `outbox` reference the conversation, so neither can hold that reply.
 */
type SendTarget =
  | { account: ChannelAccount }
  | { unsendable: ChannelAccount | null; reason: string; recordable: boolean };

async function resolveAccount(ref: ConversationRef): Promise<SendTarget> {
  const account = await ChannelAccountService.getById(ref.channelAccountId);

  if (!account) {
    logger.error(
      { channelAccountId: ref.channelAccountId, tenantId: ref.tenantId },
      "Channel account not found for conversation",
    );
    return { unsendable: null, reason: "account_not_found", recordable: false };
  }

  if (account.channel_type === "simulator") {
    // The simulator's turns record their replies instead of sending them, so
    // a send reaching here is a bug and Meta must not see it.
    logger.error(
      { channelAccountId: account.id, tenantId: ref.tenantId },
      "Refusing to send on the simulator channel",
    );
    return { unsendable: null, reason: "simulator", recordable: true };
  }

  if (account.tenant_id !== ref.tenantId) {
    // A mismatch means the conversation ref was assembled from two tenants.
    // Refuse it instead of sending on the wrong account.
    logger.error(
      {
        channelAccountId: account.id,
        accountTenantId: account.tenant_id,
        refTenantId: ref.tenantId,
      },
      "Channel account does not belong to the conversation's tenant",
    );
    return { unsendable: null, reason: "tenant_mismatch", recordable: false };
  }

  if (!(await TenantService.isOpen(account.tenant_id))) {
    // A suspended tenant sends nothing to customers. `sendDirect` skips this
    // check so platform alerts about a closed business still go out.
    logger.warn(
      { channelAccountId: account.id, tenantId: account.tenant_id },
      "Refusing to send for a tenant that is not active",
    );
    return { unsendable: null, reason: "tenant_not_active", recordable: true };
  }

  // This check runs after the tenant check. A suspended business whose number
  // is also switched off is refused as suspended, which does not throw.
  if (account.status !== "active") {
    logger.warn(
      {
        channelAccountId: account.id,
        tenantId: account.tenant_id,
        status: account.status,
      },
      "Refusing to send on a channel account that is not active",
    );
    return {
      unsendable: account,
      reason: "account_not_active",
      recordable: true,
    };
  }

  return { account };
}

function logFailure(
  ref: ConversationRef,
  outcome: Extract<SendOutcome, { ok: false }>,
  what: "message" | "image",
): void {
  logger.warn(
    {
      tenantId: ref.tenantId,
      channelAccountId: ref.channelAccountId,
      kind: outcome.kind,
      reason: outcome.reason,
      status: outcome.status,
    },
    `WhatsApp ${what} send failed`,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where an Instagram send falls in the window the customer's last message
 * opened. Only a person's reply may go out after the first 24 hours, and
 * nothing after 7 days.
 */
async function instagramWindow(
  ref: ConversationRef,
  sender: Sender,
): Promise<InstagramWindow | null> {
  const last = await MessageStore.lastInboundAt(ref);
  if (last === null) return null;
  const age = Date.now() - last;
  if (age <= DAY_MS) return "open";
  if (sender === "person" && age <= 7 * DAY_MS) return "human_agent";
  return null;
}

/** Who wrote a send: the bot and notifications, or a person replying by hand. */
type Sender = "automated" | "person";

/** What the send methods pass the adapter, from either a caller or an outbox row. */
async function callAdapter(
  account: ChannelAccount,
  ref: ConversationRef,
  message: OutboundMessage,
  sender: Sender,
): Promise<SendOutcome> {
  const to = ref.phoneNumber;
  if (account.channel_type === "instagram") {
    const window = await instagramWindow(ref, sender);
    if (!window) {
      return { ok: false, kind: "permanent", reason: "outside_window" };
    }
    return InstagramAdapter.send(account, to, message, window);
  }
  if (message.type === "image") {
    return adapter.sendImage(account, to, message.content, message.caption);
  }
  if (message.type === "template") {
    return adapter.sendTemplate(account, to, message.template);
  }
  return adapter.sendMessage(account, to, message.content);
}

/**
 * Resolve the conversation's account and send, writing nothing to `messages`.
 * The outbox sender uses it, because it already owns the row a retry updates.
 * A refusal `resolveAccount` reports comes back as a `permanent` outcome.
 *
 * @throws ChannelUnavailableError when the number is switched off
 */
export async function sendResolved(
  ref: ConversationRef,
  message: OutboundMessage,
): Promise<SendOutcome> {
  const target = await resolveAccount(ref);
  if (!("account" in target)) {
    if (target.unsendable) {
      throw new ChannelUnavailableError(ref, target.unsendable.status);
    }
    return { ok: false, kind: "permanent", reason: target.reason };
  }

  const outcome = await callAdapter(target.account, ref, message, "automated");
  if (!outcome.ok) {
    logFailure(ref, outcome, message.type === "image" ? "image" : "message");
  }
  return outcome;
}

/** The reply queued behind one the conversation already owes. No attempt was made. */
const QUEUED_BEHIND: Extract<SendOutcome, { ok: false }> = {
  ok: false,
  kind: "transient",
  reason: "queued_behind",
};

/**
 * Send one message and write the `messages` row for it. With `retry` on, a
 * failure a later attempt could fix goes on the outbox instead of being lost,
 * and the row this writes is the one the worker moves.
 */
async function deliver(
  ref: ConversationRef,
  message: OutboundMessage,
  retry: boolean,
): Promise<SendResult> {
  const productId = message.type === "image" ? message.productId : undefined;
  const store = async (status: string, whatsappMessageId?: string) =>
    await MessageStore.log(
      ref,
      "outbound",
      message.type,
      message.content,
      status,
      whatsappMessageId,
      productId,
    );

  // Replies to one conversation go out in the order the bot produced them, so
  // once one is queued the rest of the turn queues behind it unattempted.
  if (retry && (await hasQueuedReply(ref))) {
    const now = Date.now();
    const messageId = await store("queued");
    await enqueue({ ref, messageId, message, state: queuedBehind(now), now });
    return { ...QUEUED_BEHIND, queued: true };
  }

  const target = await resolveAccount(ref);

  let outcome: SendOutcome;
  if ("account" in target) {
    // Only an agent's manual reply sends without `retry`.
    outcome = await callAdapter(
      target.account,
      ref,
      message,
      retry ? "automated" : "person",
    );

    if (outcome.ok) {
      await store("sent", outcome.messageId);
      return outcome;
    }

    logFailure(ref, outcome, message.type === "image" ? "image" : "message");
  } else {
    if (!target.recordable) {
      return { ok: false, kind: "permanent", reason: target.reason };
    }
    if (target.unsendable) {
      await store("failed");
      throw new ChannelUnavailableError(ref, target.unsendable.status);
    }
    // `resolveAccount` logged the refusal.
    outcome = { ok: false, kind: "permanent", reason: target.reason };
  }

  if (!retry) {
    await store("failed");
    return outcome;
  }

  // The handoff finds a refusal in the `failed` row written here.
  const now = Date.now();
  const state = stepOutbox(
    { attempts: 0, ambiguousAttempts: 0, createdAt: now },
    outcome,
    now,
  );
  const queued = state.status === "pending";
  const messageId = await store(queued ? "queued" : "failed");
  await enqueue({ ref, messageId, message, state, now });

  return queued ? { ...outcome, queued: true } : outcome;
}

export const WhatsAppService = {
  /**
   * Returns what the send did. A refusal `resolveAccount` reports as
   * `unsendable: null` comes back as a `permanent` outcome. It leaves a `failed`
   * `messages` row, and with `retry` a `failed` outbox row, unless the ref names
   * no conversation to write them for. An inactive account of an open tenant
   * throws `ChannelUnavailableError` and leaves no outbox row: the caller keeps
   * the customer's message and answers it once the number is back.
   *
   * `retry` puts a reply the send could not deliver on the outbox, where the
   * worker sends it again. Only the bot's turn passes it. An agent's manual
   * reply does not, because the agent is shown the error instead.
   */
  async sendMessage(
    ref: ConversationRef,
    content: string,
    options: { retry?: boolean } = {},
  ): Promise<SendResult> {
    return deliver(ref, { type: "text", content }, options.retry === true);
  },

  async sendImage(
    ref: ConversationRef,
    imagePath: string,
    caption?: string,
    productId?: string,
    options: { retry?: boolean } = {},
  ): Promise<SendResult> {
    return deliver(
      ref,
      { type: "image", content: imagePath, caption, productId },
      options.retry === true,
    );
  },

  /**
   * Send to a number that is not a customer conversation (an agent's phone, a
   * WhatsApp group). Nothing is written to `messages`: these are not part of a
   * conversation thread, and notification delivery is recorded separately in
   * `notification_traces`.
   */
  async sendDirect(
    account: ChannelAccount,
    to: string,
    content: string,
  ): Promise<boolean> {
    const outcome = await adapter.sendMessage(account, to, content);
    if (!outcome.ok) {
      logger.warn(
        {
          channelAccountId: account.id,
          kind: outcome.kind,
          reason: outcome.reason,
          status: outcome.status,
        },
        "WhatsApp direct send failed",
      );
    }
    return outcome.ok;
  },

  /**
   * Unlike the send methods, this does not throw for an account that is not
   * active. It runs before the reply is worked out, including for simulated
   * conversations, which use whichever number the tenant has. `typing` requests
   * the customer-facing typing indicator.
   */
  async markAsRead(
    ref: ConversationRef,
    messageId: string,
    options: { typing: boolean },
  ): Promise<void> {
    const target = await resolveAccount(ref);
    if (!("account" in target)) return;
    if (target.account.channel_type === "instagram") {
      await InstagramAdapter.markSeen(target.account, ref.phoneNumber, options);
      return;
    }
    await adapter.markAsRead(target.account, messageId, options);
  },

  async logMessage(
    ref: ConversationRef,
    direction: "inbound" | "outbound",
    type: StoredMessageType,
    content: string,
    status: string = "sent",
    productId?: string,
  ): Promise<void> {
    await MessageStore.log(
      ref,
      direction,
      type,
      content,
      status,
      undefined,
      productId,
    );
  },

  async getMessageHistory(
    ref: ConversationRef,
    limit: number = 50,
  ): Promise<ConversationMessage[]> {
    return await MessageStore.getHistory(ref, limit);
  },

  async clearMessageHistory(ref: ConversationRef): Promise<void> {
    await MessageStore.clear(ref);
  },

  async findProductByQuotedMessage(
    ref: ConversationRef,
    whatsappMessageId: string,
  ): Promise<string | null> {
    return await MessageStore.findProductByMessageId(ref, whatsappMessageId);
  },

  async getMessageById(
    ref: ConversationRef,
    whatsappMessageId: string,
  ): Promise<ConversationMessage | null> {
    return await MessageStore.getMessageById(ref, whatsappMessageId);
  },
};
