import { createCompletion } from "@vendeya/intelligence";
import type { Compilable } from "kysely";
import type { ConversationRef, QuotedMessageContext } from "@vendeya/types";
import {
  ChannelUnavailableError,
  WhatsAppService,
} from "../../adapters/whatsapp/index.ts";
import { batch } from "../../db/index.ts";
import {
  type AgentTurn,
  AssistantUnavailableError,
  runAgent,
} from "../../domains/assistant/agent.ts";
import type { ToolEffect } from "../../domains/assistant/tools/index.ts";
import { CustomerService } from "../../domains/customers/index.ts";
import { assignNextAgentHeld } from "../../domains/conversations/assignment.ts";
import { openAiApiKey } from "../../domains/settings/openai.ts";
import { createLogger } from "../../lib/logger.ts";
import { createEvent, eventBus } from "../../shared/events/index.ts";
import { markAsProcessed } from "../message-inbox.ts";
import {
  activityUpdate,
  ensureConversation,
  findConversation,
  handOffUpdate,
  releaseIfIdle,
} from "../store.ts";
import { claimMessageAlert, raiseUnreadAlert } from "../unread-alerts.ts";
import { calculateResponseDelay } from "./response-timing.ts";
import { sleep } from "./sleep.ts";

const logger = createLogger("conversation");

export type IncomingMessage = {
  /** Which tenant, which of its numbers, and the contact writing in. */
  ref: ConversationRef;
  content: string;
  timestamp: number;
  messageId: string;
  quotedContext?: QuotedMessageContext;
  /**
   * The queue rows this message was grouped from, as `message_inbox` ids joined
   * by commas. They become `processed` in the batch that records the
   * turn, and stay as they were if the turn throws.
   */
  inboxIds?: string;
};

type HandOff = Extract<ToolEffect, { kind: "hand_off" }>;
type Photos = Extract<ToolEffect, { kind: "send_photos" }>;
type OrderCreated = Extract<ToolEffect, { kind: "order_created" }>;

/**
 * One turn. The caller holds the conversation lock, which only
 * `ConversationObject` takes.
 */
export async function answerMessage(message: IncomingMessage): Promise<void> {
  const { ref, content, timestamp, messageId, quotedContext, inboxIds } =
    message;
  const { tenantId, channelAccountId, phoneNumber } = ref;

  let conversation = await ensureConversation(ref);
  if (await releaseIfIdle(ref)) {
    logger.info({ tenantId, phoneNumber }, "Idle hold released");
    conversation = (await findConversation(ref))!;
  }

  const traceId = crypto.randomUUID();
  const eventContext = { traceId, tenantId, channelAccountId };

  // A simulated turn answers like a real one but touches nothing outside the
  // conversation: no read receipt, order, notification, assigned agent or
  // unread alert.
  const real = conversation.is_simulation !== 1;

  // A person holds the conversation, so the assistant stays out of it.
  const held = conversation.status === "human_takeover";
  if (real) {
    await WhatsAppService.markAsRead(ref, messageId, { typing: !held });
  }

  // Set once the turn is recorded. A failure before it is passed on: the
  // caller owns the queue rows and decides whether to try again. A failure
  // after it is absorbed, because trying again would repeat a reply that
  // went out and was recorded.
  let recorded = false;

  try {
    if (held) {
      await recordTurn(ref, null, inboxIds);
      recorded = true;
      if (real && (await claimMessageAlert(ref))) {
        await eventBus.emit(
          createEvent(
            "customer_message_received",
            {
              phoneNumber,
              clientName: (
                await CustomerService.getByPhone(tenantId, phoneNumber)
              )?.name,
            },
            eventContext,
          ),
        );
      }
      return;
    }

    const turn = await workOutTurn(ref, real, quotedContext?.body);
    const handOff = turn.effects.find(
      (effect): effect is HandOff => effect.kind === "hand_off",
    );
    const orders = turn.effects.filter(
      (effect): effect is OrderCreated => effect.kind === "order_created",
    );

    const delay = calculateResponseDelay(timestamp, Date.now());
    if (delay > 0 && hasOutput(turn)) await sleep(delay);

    try {
      await sendTurn(ref, turn, !real);
    } catch (error) {
      // The order exists now. Leaving the message on its queue would answer
      // it again and create a second order, so the turn is recorded without
      // its reply and staff learn of the order from its alert.
      if (!(error instanceof ChannelUnavailableError) || orders.length === 0) {
        throw error;
      }
      logger.warn(
        { tenantId, channelAccountId, phoneNumber, status: error.status },
        "Channel switched off after an order was created; recording the turn without its reply",
      );
    }

    await recordTurn(ref, handOff ?? null, inboxIds);
    recorded = true;

    // Events go out after the turn is recorded: a send that throws puts the
    // message back on its queue, and anything emitted before that point
    // would be emitted twice.
    if (!real) return;
    for (const { order } of orders) {
      await eventBus.emit(
        createEvent(
          "order_created",
          {
            orderId: order.id,
            orderNumber: String(order.number),
            amountCents: order.total_cents,
            clientName: order.customer.name,
            phoneNumber,
            productName: order.lines.map((line) => line.name).join(", "),
          },
          eventContext,
        ),
      );
    }
    // The agent is assigned before the alert, so the alert reaches them and
    // not the sales group. Both are awaited inside the lock: the next message
    // must see the unread marker as this turn left it.
    if (handOff) {
      await assignNextAgentHeld(ref);
      await raiseUnreadAlert(ref);
      await eventBus.emit(
        createEvent(
          "escalation_triggered",
          {
            phoneNumber,
            reason: handOff.reason,
            context: { message: content },
          },
          eventContext,
        ),
      );
    }
  } catch (error) {
    if (error instanceof ChannelUnavailableError) {
      // Not a processing failure and not something to alert about: the
      // business switched this number off. The caller is the queue the
      // message came from, and it needs the throw to know the reply never
      // went out, so this is the one error that is passed on rather than
      // absorbed here.
      logger.warn(
        {
          tenantId,
          channelAccountId,
          phoneNumber,
          messageId,
          status: error.status,
        },
        "Channel account is not active; leaving this message for its queue",
      );
      throw error;
    }

    logger.error(
      { error, tenantId, phoneNumber, messageId, traceId, recorded },
      "Message processing failed",
    );

    // A simulated failure reaches the person at the simulator as an error.
    if (!real) throw error;

    await eventBus.emit(
      createEvent(
        "system_error_occurred",
        {
          phoneNumber,
          error: "Error processing message",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        },
        eventContext,
      ),
    );

    if (!recorded) throw error;
  }
}

/**
 * The assistant's answer. A real conversation without a key goes to staff,
 * since no retry can answer it. A model failure is thrown for the queue to
 * retry and then hand off, unless the turn already created an order: a
 * retry would create it again, so the conversation goes to staff at once
 * with the order still announced. The simulator shows every failure.
 */
async function workOutTurn(
  ref: ConversationRef,
  real: boolean,
  quoted: string | undefined,
): Promise<AgentTurn> {
  const apiKey = await openAiApiKey(ref.tenantId);
  if (!apiKey) {
    if (!real) throw new Error("The business has no OpenAI key");
    return {
      reply: "",
      effects: [{ kind: "hand_off", reason: "no_openai_key" }],
    };
  }
  try {
    return await runAgent({
      ref,
      simulated: !real,
      complete: createCompletion(apiKey),
      quoted,
    });
  } catch (error) {
    if (
      !real ||
      !(error instanceof AssistantUnavailableError) ||
      !error.effects.some((effect) => effect.kind === "order_created")
    ) {
      throw error;
    }
    logger.warn(
      { tenantId: ref.tenantId, phoneNumber: ref.phoneNumber, error },
      "The assistant model failed after creating an order; handing the conversation to staff",
    );
    return {
      reply: "",
      effects: [
        ...error.effects,
        { kind: "hand_off", reason: "assistant_unavailable" },
      ],
    };
  }
}

function hasOutput(turn: AgentTurn): boolean {
  return (
    turn.reply !== "" || turn.effects.some((e) => e.kind === "send_photos")
  );
}

/** The reply first, then the photos a tool asked for, in order. */
async function sendTurn(
  ref: ConversationRef,
  turn: AgentTurn,
  simulated: boolean,
): Promise<void> {
  if (turn.reply) await sendText(ref, turn.reply, simulated);
  for (const effect of turn.effects) {
    if (effect.kind === "send_photos") await sendPhotos(ref, effect, simulated);
  }
}

async function sendText(
  ref: ConversationRef,
  content: string,
  simulated: boolean,
): Promise<void> {
  if (simulated) {
    await WhatsAppService.logMessage(ref, "outbound", "text", content, "sent");
    return;
  }
  const outcome = await WhatsAppService.sendMessage(ref, content, {
    retry: true,
  });
  if (!outcome.ok && !outcome.queued) {
    logger.warn(
      { tenantId: ref.tenantId, kind: outcome.kind, reason: outcome.reason },
      "Reply was not sent",
    );
  }
}

/** The product's name captions its first photo only. */
async function sendPhotos(
  ref: ConversationRef,
  photos: Photos,
  simulated: boolean,
): Promise<void> {
  for (const [index, key] of photos.storageKeys.entries()) {
    if (simulated) {
      await WhatsAppService.logMessage(
        ref,
        "outbound",
        "image",
        key,
        "sent",
        photos.productId,
      );
      continue;
    }
    const outcome = await WhatsAppService.sendImage(
      ref,
      key,
      index === 0 ? photos.productName : undefined,
      photos.productId,
      { retry: true },
    );
    if (!outcome.ok && !outcome.queued) {
      logger.warn(
        { tenantId: ref.tenantId, kind: outcome.kind, reason: outcome.reason },
        "Product photo was not sent",
      );
    }
  }
}

/**
 * The turn's mark on the conversation and its settled queue rows commit
 * together. Without a hand-off only the activity time is written, so a
 * hand-off made while the turn ran, as when Meta refuses the reply, stands.
 */
async function recordTurn(
  ref: ConversationRef,
  handOff: HandOff | null,
  inboxIds: string | undefined,
): Promise<void> {
  const statements: Compilable[] = [
    handOff ? handOffUpdate(ref, handOff.reason) : activityUpdate(ref),
  ];
  if (inboxIds) statements.push(markAsProcessed(inboxIds));
  await batch(statements);
}
