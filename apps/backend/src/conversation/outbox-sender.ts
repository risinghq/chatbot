import {
  claimRow,
  deferUnavailable,
  expirePending,
  headRow,
  interruptedRows,
  outboundOf,
  recordOutcome,
  type OutboxRow,
  type OutboxStep,
} from "./outbox.ts";
import {
  ChannelUnavailableError,
  sendResolved,
} from "../adapters/whatsapp/index.ts";
import type { SendOutcome } from "../adapters/whatsapp/types.ts";
import type { ConversationRef } from "@vendeya/types";
import { createLogger } from "../lib/logger.ts";

const logger = createLogger("outbox-sender");

/** Due rows one pass sends before it yields to the rest of the pass. */
const MAX_SENDS_PER_PASS = 10;

export type PassClock = () => number;

/**
 * What the time is now, for a pass that started at `now`. A delay counted from
 * the pass's start has partly elapsed by the time the row is written, which
 * puts an ambiguous retry straight back in the next pass and loses the spacing
 * that keeps a duplicate apart. `performance.now()` is monotonic, so a wall
 * clock that steps cannot move the delay.
 */
export function passClock(now: number): PassClock {
  const started = performance.now();
  return () => now + Math.round(performance.now() - started);
}

/**
 * Sends the conversation's due replies in order. The caller holds the lock
 * from the claim to the recorded outcome, so a takeover never sees a live
 * attempt's `sending` row and this never sends a row a takeover cancelled.
 */
export async function sendDueReplies(
  ref: ConversationRef,
  at: PassClock,
): Promise<void> {
  await expirePending(ref, at());

  for (let sent = 0; sent < MAX_SENDS_PER_PASS; sent++) {
    const now = at();
    const head = await headRow(ref);
    if (head?.status !== "pending") return;
    if (head.next_attempt_at > now) return;

    const claimed = await claimRow(head, now);
    if (!claimed) {
      logger.warn(
        { outboxId: head.id },
        "Outbox row moved before it could be claimed",
      );
      return;
    }

    const step = await attempt(ref, claimed, at);
    if (step?.status !== "sent") return;
  }
}

/**
 * Sends the claimed row and records what happened. Every path either defers the
 * row or records an outcome, so only a write the database refuses leaves it
 * `sending`. Returns the recorded step, or undefined when the row was deferred.
 */
async function attempt(
  ref: ConversationRef,
  row: OutboxRow,
  at: PassClock,
): Promise<OutboxStep | undefined> {
  let outcome: SendOutcome;

  try {
    outcome = await sendResolved(ref, outboundOf(row));
  } catch (error) {
    if (error instanceof ChannelUnavailableError) {
      // The number was switched off. No attempt reached WhatsApp, so none is
      // counted and the row waits for the number to come back.
      await deferUnavailable(row.id, at());
      logger.warn(
        {
          outboxId: row.id,
          channelAccountId: ref.channelAccountId,
          status: error.status,
        },
        "Channel account is not active; the queued reply waits",
      );
      return undefined;
    }

    // The adapters answer with an outcome rather than throwing, so whatever
    // reached here may still have put the message on the wire.
    outcome = { ok: false, kind: "ambiguous", reason: "send_threw" };
    logger.error({ error, outboxId: row.id }, "Outbox send threw");
  }

  // The delay the step schedules runs from here, the end of the attempt.
  const step = await recordOutcome(row, outcome, at());

  logger.info(recordedOutcome(row, step), "Outbox attempt recorded");
  return step;
}

/**
 * The fields every recorded outcome is logged with. No phone number, no message
 * text and no token: `reason` is the adapter's short label.
 */
function recordedOutcome(row: OutboxRow, step: OutboxStep) {
  return {
    outboxId: row.id,
    messageId: row.message_id,
    tenantId: row.tenant_id,
    channelAccountId: row.channel_account_id,
    kind: step.lastKind,
    reason: step.lastReason,
    attempts: step.attempts,
    status: step.status,
  };
}

/**
 * Turns each row an ended object left `sending` into one ambiguous attempt.
 * The caller holds the lock in a fresh object, so such a row cannot belong to
 * a live attempt.
 */
export async function recoverInterruptedSends(
  ref: ConversationRef,
): Promise<void> {
  const rows = await interruptedRows(ref);
  if (rows.length === 0) return;

  const now = Date.now();
  for (const row of rows) {
    const step = await recordOutcome(
      row,
      { ok: false, kind: "ambiguous", reason: "interrupted" },
      now,
    );
    logger.info(recordedOutcome(row, step), "Outbox attempt recorded");
  }

  logger.warn({ count: rows.length }, "Recovered interrupted outbox attempts");
}
