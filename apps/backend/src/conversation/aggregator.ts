import {
  type AggregatedGroup,
  groupReadyAt,
  markAsPending,
  markAsProcessing,
  pendingGroup,
  recordFailedTurn,
} from "./message-inbox.ts";
import { answerMessage } from "./handler/index.ts";

import { ChannelUnavailableError } from "../adapters/whatsapp/index.ts";
import type { ConversationRef, QuotedMessageContext } from "@vendeya/types";
import { createLogger } from "../lib/logger.ts";

const logger = createLogger("aggregator");

/**
 * Answers the conversation's pending messages as one turn once their quiet
 * window has passed. The caller holds the conversation lock. Returns when the
 * group is due if it is not yet, so the caller can set an alarm for it.
 */
export async function answerPendingMessages(
  ref: ConversationRef,
  now: number,
): Promise<number | undefined> {
  const group = await pendingGroup(ref);
  if (!group) return undefined;

  const readyAt = groupReadyAt(group);
  if (readyAt > now) return readyAt;

  await processGroup(ref, group);
  return undefined;
}

/** One conversation's batch. Its statuses are listed in message-inbox.ts. */
async function processGroup(
  ref: ConversationRef,
  group: AggregatedGroup,
): Promise<void> {
  await markAsProcessing(group.ids);

  logger.debug(
    { tenantId: ref.tenantId, phoneNumber: ref.phoneNumber, ids: group.ids },
    "Processing group",
  );

  try {
    await answerMessage({
      ref,
      content: group.aggregated_text,
      timestamp: group.oldest_timestamp,
      messageId: group.latest_message_id,
      quotedContext: parseQuotedContext(group, ref),
      inboxIds: group.ids,
    });
  } catch (error) {
    await recordUnanswered(group, ref, error);
  }
}

function parseQuotedContext(
  group: AggregatedGroup,
  ref: ConversationRef,
): QuotedMessageContext | undefined {
  if (!group.quoted_message_context) return undefined;

  try {
    return JSON.parse(group.quoted_message_context);
  } catch (error) {
    logger.warn(
      { error, tenantId: ref.tenantId, phoneNumber: ref.phoneNumber },
      "Failed to parse quoted context",
    );
    return undefined;
  }
}

async function recordUnanswered(
  group: AggregatedGroup,
  ref: ConversationRef,
  error: unknown,
): Promise<void> {
  const context = {
    tenantId: ref.tenantId,
    channelAccountId: ref.channelAccountId,
    phoneNumber: ref.phoneNumber,
    ids: group.ids,
  };

  if (error instanceof ChannelUnavailableError) {
    // The number was switched off between the dequeue and a send, and
    // `pendingGroup` keeps the group out of every pass until it is back. The
    // replay is faithful because `executeCommands` persists the phase and
    // analytics, and the orchestrator emits events, only after every send went
    // out. An earlier message of the same batch may already have reached the
    // customer, and the retry sends it again.
    await markAsPending(group.ids);
    logger.warn(
      { ...context, status: error.status },
      "Channel account is not active; left the group pending for later",
    );
    return;
  }

  // The turn threw before it was recorded, so no reply went out for these
  // rows. The second failure fails them, and the handoff gives their
  // conversation to a person.
  await recordFailedTurn(
    ref,
    group.ids,
    group.attempts,
    error instanceof Error ? error.message : String(error),
  );
  logger.error({ ...context, error }, "Turn failed; no reply was recorded");
}
