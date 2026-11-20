import { createProvider } from "@vendeya/intelligence";
import type { ConversationRef, QuotedMessageContext } from "@vendeya/types";
import {
  ChannelUnavailableError,
  WhatsAppService,
} from "../../adapters/whatsapp/index.ts";
import { ProductService } from "../../domains/catalog/products.ts";
import { assignNextAgentHeld } from "../../domains/conversations/assignment.ts";
import { openAiApiKey } from "../../domains/settings/openai.ts";
import { createLogger } from "../../lib/logger.ts";
import { createEvent, eventBus } from "../../shared/events/index.ts";
import { claimMessageAlert, raiseUnreadAlert } from "../unread-alerts.ts";
import {
  getOrCreateConversation,
  isSessionTimedOut,
  resetSession,
} from "../store.ts";
import { executeCommands } from "./command-executor.ts";
import { runEnrichmentLoop } from "./enrichment-loop.ts";
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

/**
 * One turn. The caller holds the conversation lock, which only
 * `ConversationObject` takes.
 */
export async function answerMessage(message: IncomingMessage): Promise<void> {
  const { ref, content, timestamp, messageId, quotedContext, inboxIds } =
    message;
  const { tenantId, channelAccountId, phoneNumber } = ref;

  logger.debug(
    { tenantId, phoneNumber, messageId, hasQuoted: !!quotedContext },
    "Processing message",
  );

  let conversation = await getOrCreateConversation(ref);

  if (isSessionTimedOut(conversation.metadata)) {
    logger.info(
      {
        tenantId,
        phoneNumber,
        lastCategory: conversation.metadata.lastCategory,
      },
      "Session timeout reset",
    );
    await resetSession(ref, conversation.metadata.lastCategory);
    // Reload the reset state so the turn cannot write the timed-out phase
    // back when it records its result.
    conversation = await getOrCreateConversation(ref);
  }

  const traceId = crypto.randomUUID();
  const eventContext = { traceId, tenantId, channelAccountId };

  // A simulated turn moves the conversation like a real one but touches
  // nothing outside it: no read receipt, order, notification, assigned agent
  // or unread alert. Its analytics carry `is_simulation`, so they stay.
  const real = !conversation.isSimulation;

  // A person-held conversation gets a read receipt but no typing indicator
  // because the bot sends no reply.
  const held = conversation.phase.phase === "escalated";
  if (real) {
    await WhatsAppService.markAsRead(ref, messageId, { typing: !held });
  }

  // Set once the turn is recorded. A failure before it is passed on: the
  // caller owns the queue rows and decides whether to try again. A failure
  // after it is absorbed, because trying again would repeat a reply that
  // went out and was recorded.
  let recorded = false;

  try {
    const provider = createProvider(await openAiApiKey(tenantId));

    const catalogContext = {
      activeBrands: await ProductService.getActiveBrands(tenantId),
      activeCategories: await ProductService.getCategories(tenantId),
    };

    const result = await runEnrichmentLoop(
      conversation.phase,
      content,
      conversation.metadata,
      ref,
      provider,
      quotedContext,
      catalogContext,
    );

    const delay = calculateResponseDelay(timestamp, Date.now());
    if (delay > 0) {
      await sleep(delay);
    }

    await executeCommands(
      result,
      ref,
      conversation.metadata,
      conversation.isSimulation,
      traceId,
      inboxIds,
    );
    recorded = true;

    // The transition's events go out after its replies, for the reason
    // `executeCommands` persists the phase after them: a send that throws
    // puts this message back on its queue to be answered again from the
    // same phase, and anything emitted before that point is emitted twice.
    // `purchase_confirmed` creates an order, so emitted first it turned one
    // number switched off mid-confirmation into two orders for one sale.
    if (real && result.events && result.events.length > 0) {
      for (const event of result.events) {
        await eventBus.emit({ ...event, ...eventContext });
      }
    }

    // The only place a turn emits `escalation_triggered`. Core and the
    // enrichment loop leave it out of `result.events`. An escalated
    // conversation stays escalated on every later message, and only the turn
    // that escalates it alerts and picks an agent. The agent is assigned
    // first, so the alert reaches them and not the sales group.
    // A later held message alerts the assigned agent only when no unread
    // alert already represents the conversation. Both alerts are awaited
    // inside the lock: the next message must see the marker as the delivery
    // left it, kept or released.
    if (
      real &&
      result.type === "update" &&
      result.nextPhase.phase === "escalated"
    ) {
      if (!held) {
        await assignNextAgentHeld(ref);
        await raiseUnreadAlert(ref);
        await eventBus.emit(
          createEvent(
            "escalation_triggered",
            {
              phoneNumber,
              reason: result.nextPhase.reason,
              context: {
                phase: conversation.phase.phase,
                message: content,
              },
            },
            eventContext,
          ),
        );
      } else if (await claimMessageAlert(ref)) {
        await eventBus.emit(
          createEvent(
            "customer_message_received",
            { phoneNumber, clientName: conversation.metadata.name },
            eventContext,
          ),
        );
      }
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
      {
        error,
        tenantId,
        phoneNumber,
        messageId,
        phase: conversation.phase.phase,
        traceId,
        recorded,
      },
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
            phase: conversation.phase.phase,
          },
        },
        eventContext,
      ),
    );

    if (!recorded) throw error;
  }
}
