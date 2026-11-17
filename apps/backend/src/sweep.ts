import type { ConversationRef } from "@vendeya/types";
import {
  conversationsWithFailedTurns,
  conversationsWithWaitingMessages,
} from "./conversation/message-inbox.ts";
import {
  conversationsAwaitingHandoff,
  conversationsNeedingOutbox,
  conversationsWithInterruptedSends,
  purgeFinishedOutbox,
} from "./conversation/outbox.ts";
import { purgeProcessedMessages } from "./conversation/processed-retention.ts";
import { lockKey } from "./conversation/locks.ts";
import { conversationStub } from "./conversation/stub.ts";
import { checkAndReassignTimeouts } from "./domains/conversations/assignment.ts";
import { createLogger } from "./lib/logger.ts";

const logger = createLogger("sweep");

/**
 * The cron trigger's minute. Each conversation's own alarm does its work on
 * time; the sweep wakes the ones whose alarm cannot know they are due: a
 * number or tenant switched back on, a wake that was lost, a row an ended
 * object left mid-flight. It also hands timed-out assignments to the next
 * agent, and once an hour deletes rows past retention.
 */
export async function sweep(scheduledTime: number): Promise<void> {
  await Promise.all([
    guarded("wake conversations", () => wakeDue(scheduledTime)),
    guarded("reassign timed-out conversations", () =>
      checkAndReassignTimeouts(scheduledTime),
    ),
  ]);

  if (new Date(scheduledTime).getUTCMinutes() === 0) {
    await guarded("purge processed messages", () =>
      purgeProcessedMessages(scheduledTime),
    );
    await guarded("purge finished outbox", () =>
      purgeFinishedOutbox(scheduledTime),
    );
  }
}

async function wakeDue(now: number): Promise<void> {
  const refs = new Map<string, ConversationRef>();
  for (const ref of [
    ...(await conversationsNeedingOutbox(now)),
    ...(await conversationsWithWaitingMessages(now)),
    ...(await conversationsAwaitingHandoff()),
    ...(await conversationsWithFailedTurns()),
    ...(await conversationsWithInterruptedSends()),
  ]) {
    refs.set(lockKey(ref), ref);
  }

  await Promise.all(
    [...refs.values()].map((ref) =>
      conversationStub(ref)
        .wake(ref)
        .catch((error: unknown) =>
          logger.error(
            {
              error,
              tenantId: ref.tenantId,
              channelAccountId: ref.channelAccountId,
            },
            "Waking a conversation failed",
          ),
        ),
    ),
  );
}

/** One task that fails costs its own run, not the rest of the sweep. */
async function guarded(
  name: string,
  task: () => Promise<unknown>,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    logger.error({ error, task: name }, "Scheduled task failed");
  }
}
