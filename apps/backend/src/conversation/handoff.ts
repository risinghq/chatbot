import type { ConversationRef } from "@vendeya/types";
import { assignNextAgentHeld } from "../domains/conversations/assignment.ts";
import { TenantService } from "../domains/tenants/index.ts";
import { createLogger } from "../lib/logger.ts";

import { createEvent, eventBus } from "../shared/events/index.ts";
import {
  type FailedTurn,
  markTurnsHandedOff,
  unhandedFailedTurns,
} from "./message-inbox.ts";
import { cancelPending, markHandedOff, undeliveredRows } from "./outbox.ts";
import { escalateConversation, findConversation } from "./store.ts";
import { raiseUnreadAlert } from "./unread-alerts.ts";

/*
 * Failed outbox and inbox rows use the same handoff. The caller holds the
 * conversation lock across cancellation, escalation, assignment, alerting and
 * stamping. A crash before stamping can alert twice.
 */

const logger = createLogger("handoff");

export const REPLY_UNDELIVERABLE = "reply_undeliverable";
export const TURN_FAILED = "turn_failed";

/**
 * Hands the conversation to a person when it owns an unstamped failed row of
 * an open tenant. A suspended tenant's rows wait for it to reopen.
 */
export async function handOff(
  ref: ConversationRef,
  at: () => number,
): Promise<void> {
  const replies = await undeliveredRows(ref);
  const turns = await unhandedFailedTurns(ref);
  if (replies.length === 0 && turns.length === 0) return;
  const outboxIds = replies.map((row) => row.id);
  const inboxIds = turns.map((row) => row.id);

  if (!(await TenantService.isOpen(ref.tenantId))) return;

  try {
    await handOffRows(ref, at, replies, turns);
  } catch (error) {
    // The rows stay unstamped, so the sweep wakes the conversation to try again.
    logger.error(
      {
        error,
        tenantId: ref.tenantId,
        channelAccountId: ref.channelAccountId,
        outboxIds,
        inboxIds,
      },
      "Handoff failed for a conversation",
    );
  }
}

async function handOffRows(
  ref: ConversationRef,
  at: () => number,
  replies: Awaited<ReturnType<typeof undeliveredRows>>,
  turns: FailedTurn[],
): Promise<void> {
  const outboxIds = replies.map((row) => row.id);
  const inboxIds = turns.map((row) => row.id);

  // A failed turn takes precedence because the customer's message was never
  // answered, regardless of any outbox failure.
  const reason = turns.length > 0 ? TURN_FAILED : REPLY_UNDELIVERABLE;
  const lastReason =
    turns.length > 0
      ? turns[turns.length - 1]!.last_error
      : replies[replies.length - 1]!.last_reason;

  const cancelledReplies = await cancelPending(ref);

  // A conversation the bot escalated or a person took over keeps its state and
  // reason. It still gets the alert, because the advisor message the bot
  // queued may be the reply that failed.
  const statusBefore = (await findConversation(ref))?.status;

  if (statusBefore === "active") {
    await escalateConversation(ref, reason);
    await assignNextAgentHeld(ref);
  }

  await raiseUnreadAlert(ref);
  await eventBus.emit(
    createEvent(
      "escalation_triggered",
      {
        phoneNumber: ref.phoneNumber,
        reason,
        context: {
          failedReplies: replies.length,
          failedTurns: turns.length,
          lastReason,
        },
      },
      { tenantId: ref.tenantId, channelAccountId: ref.channelAccountId },
    ),
  );

  await markHandedOff(outboxIds, at());
  await markTurnsHandedOff(inboxIds, at());

  logger.info(
    {
      tenantId: ref.tenantId,
      channelAccountId: ref.channelAccountId,
      outboxIds,
      inboxIds,
      reason,
      cancelledReplies,
      statusBefore,
      statusAfter: (await findConversation(ref))?.status,
    },
    "Handed a conversation to a person because the customer got no answer",
  );
}
