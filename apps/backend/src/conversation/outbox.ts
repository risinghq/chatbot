import { activeChannelAccountsOnly, openTenantsOnly } from "../db/query.ts";
import { createLogger } from "../lib/logger.ts";
import type { ConversationRef } from "@vendeya/types";
import type {
  OutboundMessage,
  SendOutcome,
} from "../adapters/whatsapp/types.ts";
import { batch, getAll, getOne, run, stmt } from "../db/index.ts";

/*
 * The states of an outbox row, and who moves each one.
 *
 *  - pending: the reply is owed. `WhatsAppService` inserts it when an inline
 *    send failed in a way a later attempt can fix, or when the conversation
 *    already owed a reply and this one must queue behind it. It leaves pending
 *    through `claimRow`, `expirePending` or `cancelPending`.
 *  - sending: one attempt is in flight. The conversation's object holds the
 *    lock from the claim to the recorded outcome, so only the attempt that
 *    claimed the row moves it on. An object that ends here leaves the row
 *    sending, and the next object for the conversation records that as one
 *    ambiguous attempt before it does anything else. A database that refuses
 *    to record an outcome also leaves the row sending until then, and the
 *    conversation's later replies queue behind it.
 *  - sent: the adapter accepted it, and the `messages` row carries Meta's id.
 *  - failed: permanent, out of budget, a second ambiguous outcome, or past
 *    `MAX_AGE_MS`. `last_reason` says which. The customer got no answer, so
 *    the handoff in handoff.ts alerts a person and stamps
 *    `handed_off_at`. A failed row with no stamp is a handoff still owed.
 *    A `tenant_not_active` refusal is inserted already failed. The handoff
 *    skips suspended tenants, so its alert waits for the tenant to reopen. A
 *    ref with no account, or built from two tenants, names no conversation,
 *    so no row can exist for it. An account switched off throws instead, and
 *    the caller keeps the customer's message for when the number returns.
 *  - cancelled: a person took the conversation over before it went out.
 *
 * sent, failed and cancelled are final. The sender claims only a
 * conversation's lowest-numbered pending or sending row, so replies go out in
 * the order the bot produced them.
 */

const logger = createLogger("outbox");

/** Delay before the retry that follows attempt 1, 2, 3 and 4 of a transient failure. */
export const TRANSIENT_RETRY_DELAYS_MS = [
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
] as const;

/**
 * An ambiguous send may already have been delivered, so it is repeated once and
 * on the shortest delay, whichever attempt it happened on.
 */
export const AMBIGUOUS_RETRY_DELAY_MS = 5_000;

/** Recorded outcomes a row may collect. The inline send is attempt 1. */
export const MAX_ATTEMPTS = 5;

/** A reply this old is no longer worth delivering, so the row fails as `expired`. */
export const MAX_AGE_MS = 60 * 60 * 1000;

/** How long the sender waits after finding the conversation's number switched off. */
export const CHANNEL_UNAVAILABLE_DELAY_MS = 60_000;

/** How long a final row is kept before the hourly sweep deletes it. */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type OutboxStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

export type OutboxRow = {
  id: number;
  tenant_id: string;
  channel_account_id: string;
  phone_number: string;
  message_id: string;
  type: "text" | "image";
  content: string;
  caption: string | null;
  status: OutboxStatus;
  attempts: number;
  ambiguous_attempts: number;
  last_kind: string | null;
  last_reason: string | null;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
  handed_off_at: number | null;
};

/** What the step function reads. A row that has never been attempted has both counters at 0. */
export type OutboxCounters = {
  attempts: number;
  ambiguousAttempts: number;
  createdAt: number;
};

/** Where an outcome leaves the row. `pending` is the only non-final state it returns. */
export type OutboxStep = {
  status: "pending" | "sent" | "failed";
  attempts: number;
  ambiguousAttempts: number;
  nextAttemptAt: number;
  lastKind: string | null;
  lastReason: string | null;
};

/**
 * The retry budget, as one decision. `WhatsAppService` calls it for the inline
 * attempt and the sender for every later one, so the two cannot drift.
 */
export function stepOutbox(
  counters: OutboxCounters,
  outcome: SendOutcome,
  now: number,
): OutboxStep {
  const attempts = counters.attempts + 1;

  if (outcome.ok) {
    return {
      status: "sent",
      attempts,
      ambiguousAttempts: counters.ambiguousAttempts,
      nextAttemptAt: now,
      lastKind: "accepted",
      lastReason: null,
    };
  }

  const ambiguousAttempts =
    counters.ambiguousAttempts + (outcome.kind === "ambiguous" ? 1 : 0);
  const counted = { attempts, ambiguousAttempts, lastKind: outcome.kind };
  const failed = (reason: string): OutboxStep => ({
    ...counted,
    status: "failed",
    nextAttemptAt: now,
    lastReason: reason,
  });

  if (outcome.kind === "permanent") return failed(outcome.reason);
  if (now - counters.createdAt >= MAX_AGE_MS) return failed("expired");
  if (attempts >= MAX_ATTEMPTS) return failed("exhausted");

  // A second ambiguous outcome would risk a third delivery of the same reply.
  if (outcome.kind === "ambiguous" && ambiguousAttempts > 1) {
    return failed(outcome.reason);
  }

  const delay =
    outcome.kind === "ambiguous"
      ? AMBIGUOUS_RETRY_DELAY_MS
      : TRANSIENT_RETRY_DELAYS_MS[attempts - 1]!;

  return {
    ...counted,
    status: "pending",
    nextAttemptAt: now + delay,
    lastReason: outcome.reason,
  };
}

/** The state a row carries when it queues behind one the conversation already has. */
export function queuedBehind(now: number): OutboxStep {
  return {
    status: "pending",
    attempts: 0,
    ambiguousAttempts: 0,
    nextAttemptAt: now,
    lastKind: null,
    lastReason: null,
  };
}

/** The `messages.status` that goes with an outbox state. */
function messageStatus(status: OutboxStatus): string {
  if (status === "sent") return "sent";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "queued";
}

/** Whether this conversation already owes a reply, so a new one must queue behind it. */
export async function hasQueuedReply(ref: ConversationRef): Promise<boolean> {
  const row = await getOne<{ id: number }>(
    `SELECT id FROM outbox
     WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
       AND status IN ('pending', 'sending')
     LIMIT 1`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );
  return row !== undefined;
}

/** Append a reply to the conversation's queue. `id` gives the order it goes out in. */
export async function enqueue(args: {
  ref: ConversationRef;
  messageId: string;
  message: OutboundMessage;
  state: OutboxStep;
  now: number;
}): Promise<number> {
  const { ref, messageId, message, state, now } = args;

  const result = await run(
    `INSERT INTO outbox
         (tenant_id, channel_account_id, phone_number, message_id, type, content,
          caption, status, attempts, ambiguous_attempts, last_kind, last_reason,
          next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ref.tenantId,
      ref.channelAccountId,
      ref.phoneNumber,
      messageId,
      message.type,
      message.content,
      message.type === "image" ? (message.caption ?? null) : null,
      state.status,
      state.attempts,
      state.ambiguousAttempts,
      state.lastKind,
      state.lastReason,
      state.nextAttemptAt,
      now,
      now,
    ],
  );

  return Number(result.lastInsertRowid);
}

/**
 * What the sender needs to send a queued reply again. No product id: the
 * adapter does not take one, and the `messages` row already records it.
 */
export function outboundOf(row: OutboxRow): OutboundMessage {
  if (row.type === "image") {
    return {
      type: "image",
      content: row.content,
      caption: row.caption ?? undefined,
    };
  }
  return { type: "text", content: row.content };
}

/**
 * The conversation's lowest-numbered pending or sending row, or undefined when
 * it owes nothing. A suspended tenant owes nothing until it reopens.
 */
export async function headRow(
  ref: ConversationRef,
): Promise<OutboxRow | undefined> {
  return await getOne<OutboxRow>(
    `SELECT * FROM outbox
     WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
       AND status IN ('pending', 'sending')
       AND ${openTenantsOnly()}
     ORDER BY id
     LIMIT 1`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );
}

/**
 * Takes the row out of the pending set, so no later pass sends it twice. Gives
 * back the claimed row, or undefined when another writer moved it first.
 */
export async function claimRow(
  row: OutboxRow,
  now: number,
): Promise<OutboxRow | undefined> {
  const changed = (
    await run(
      "UPDATE outbox SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending'",
      [now, row.id],
    )
  ).changes;

  if (changed !== 1) return undefined;

  return { ...row, status: "sending", updated_at: now };
}

/**
 * Move the row and the `messages` row it owns together, so the thread never
 * shows a reply as queued once the row is final.
 */
export async function recordOutcome(
  row: OutboxRow,
  outcome: SendOutcome,
  now: number,
): Promise<OutboxStep> {
  const step = stepOutbox(
    {
      attempts: row.attempts,
      ambiguousAttempts: row.ambiguous_attempts,
      createdAt: row.created_at,
    },
    outcome,
    now,
  );

  await batch([
    stmt(
      `UPDATE outbox
       SET status = ?, attempts = ?, ambiguous_attempts = ?, last_kind = ?,
           last_reason = ?, next_attempt_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        step.status,
        step.attempts,
        step.ambiguousAttempts,
        step.lastKind,
        step.lastReason,
        step.nextAttemptAt,
        now,
        row.id,
      ],
    ),
    stmt(
      "UPDATE messages SET status = ?, whatsapp_message_id = ? WHERE id = ?",
      [
        messageStatus(step.status),
        outcome.ok ? outcome.messageId : null,
        row.message_id,
      ],
    ),
  ]);

  return step;
}

/**
 * Put a claimed row back without counting an attempt. The number the
 * conversation runs on was switched off, which no attempt could have fixed.
 */
export async function deferUnavailable(id: number, now: number): Promise<void> {
  await run(
    `UPDATE outbox SET status = 'pending', next_attempt_at = ?, updated_at = ?
     WHERE id = ? AND status = 'sending'`,
    [now + CHANNEL_UNAVAILABLE_DELAY_MS, now, id],
  );
}

/**
 * Fail the conversation's pending rows that are past the age limit. It counts
 * no attempt, because no attempt was made. A suspended tenant's rows wait for
 * it to reopen, as the sweep does.
 */
export async function expirePending(
  ref: ConversationRef,
  now: number,
): Promise<number> {
  const cutoff = now - MAX_AGE_MS;
  const identity = [ref.tenantId, ref.channelAccountId, ref.phoneNumber];

  const [, expired] = await batch([
    stmt(
      `UPDATE messages SET status = 'failed'
       WHERE id IN (
         SELECT message_id FROM outbox
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
           AND status = 'pending' AND created_at <= ?
           AND ${openTenantsOnly()}
       )`,
      [...identity, cutoff],
    ),
    stmt(
      `UPDATE outbox
       SET status = 'failed', last_reason = 'expired', updated_at = ?
       WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
         AND status = 'pending' AND created_at <= ?
         AND ${openTenantsOnly()}`,
      [now, ...identity, cutoff],
    ),
  ]);

  return expired!.meta.changes;
}

/**
 * Drop the replies the bot had queued, because a person now owns the
 * conversation or is being given it. Only `pending` rows: the caller holds the
 * conversation lock, so no attempt can be in flight. The outbox update comes
 * last, so its `meta.changes` is how many were dropped.
 */
export function cancelPendingStatements(
  ref: ConversationRef,
): D1PreparedStatement[] {
  const identity = [ref.tenantId, ref.channelAccountId, ref.phoneNumber];
  return [
    stmt(
      `UPDATE messages SET status = 'cancelled'
       WHERE id IN (
         SELECT message_id FROM outbox
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
           AND status = 'pending'
       )`,
      identity,
    ),
    stmt(
      `UPDATE outbox SET status = 'cancelled', updated_at = ?
       WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
         AND status = 'pending'`,
      [Date.now(), ...identity],
    ),
  ];
}

/** Runs `cancelPendingStatements` and gives back how many replies were dropped. */
export async function cancelPending(ref: ConversationRef): Promise<number> {
  const results = await batch(cancelPendingStatements(ref));
  return results[results.length - 1]!.meta.changes;
}

/**
 * When the conversation's outbox next needs its object: the head row's next
 * attempt on a number that can send, or the moment a pending row passes the
 * age limit. Undefined when it owes nothing an alarm could move.
 */
export async function outboxWakeAt(
  ref: ConversationRef,
): Promise<number | undefined> {
  const identity = [ref.tenantId, ref.channelAccountId, ref.phoneNumber];
  const row = await getOne<{ due: number | null; stale: number | null }>(
    `SELECT
       (SELECT next_attempt_at FROM outbox
        WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
          AND status IN ('pending', 'sending')
          AND ${activeChannelAccountsOnly()}
        ORDER BY id LIMIT 1) AS due,
       (SELECT MIN(created_at) + ? FROM outbox
        WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
          AND status = 'pending') AS stale
     WHERE ${openTenantsOnly("?")}`,
    [...identity, MAX_AGE_MS, ...identity, ref.tenantId],
  );
  const times = [row?.due, row?.stale].filter(
    (time): time is number => typeof time === "number",
  );
  return times.length === 0 ? undefined : Math.min(...times);
}

/**
 * The conversations the sweep wakes: those with a row past the age limit, and
 * those whose head row is due on a number that can send.
 */
export async function conversationsNeedingOutbox(
  now: number,
): Promise<ConversationRef[]> {
  const stale = await getAll<{
    tenant_id: string;
    channel_account_id: string;
    phone_number: string;
  }>(
    `SELECT DISTINCT tenant_id, channel_account_id, phone_number FROM outbox
     WHERE status = 'pending' AND created_at <= ? AND ${openTenantsOnly()}`,
    [now - MAX_AGE_MS],
  );

  const due = await getAll<{
    tenant_id: string;
    channel_account_id: string;
    phone_number: string;
  }>(
    `SELECT o.tenant_id, o.channel_account_id, o.phone_number FROM outbox o
     WHERE o.status = 'pending'
       AND o.next_attempt_at <= ?
       AND o.id = (
         SELECT MIN(head.id) FROM outbox head
         WHERE head.tenant_id = o.tenant_id
           AND head.channel_account_id = o.channel_account_id
           AND head.phone_number = o.phone_number
           AND head.status IN ('pending', 'sending')
       )
       AND ${openTenantsOnly("o.tenant_id")}
       AND ${activeChannelAccountsOnly("o.channel_account_id")}`,
    [now],
  );

  const refs = new Map<string, ConversationRef>();
  for (const row of [...stale, ...due]) {
    const ref = {
      tenantId: row.tenant_id,
      channelAccountId: row.channel_account_id,
      phoneNumber: row.phone_number,
    };
    refs.set(`${ref.tenantId}:${ref.channelAccountId}:${ref.phoneNumber}`, ref);
  }

  return [...refs.values()];
}

/** The conversation's `failed` rows that no handoff has covered yet, oldest first. */
export async function undeliveredRows(
  ref: ConversationRef,
): Promise<OutboxRow[]> {
  return await getAll<OutboxRow>(
    `SELECT * FROM outbox
     WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
       AND status = 'failed' AND handed_off_at IS NULL
     ORDER BY id`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );
}

/**
 * The conversations that own a `failed` row no handoff has covered. A suspended
 * tenant's rows wait for it to reopen.
 */
export async function conversationsAwaitingHandoff(): Promise<
  ConversationRef[]
> {
  return (
    await getAll<{
      tenant_id: string;
      channel_account_id: string;
      phone_number: string;
    }>(
      `SELECT DISTINCT tenant_id, channel_account_id, phone_number FROM outbox
     WHERE status = 'failed' AND handed_off_at IS NULL AND ${openTenantsOnly()}`,
    )
  ).map((row) => ({
    tenantId: row.tenant_id,
    channelAccountId: row.channel_account_id,
    phoneNumber: row.phone_number,
  }));
}

/**
 * Stamps the handoff on `failed` rows. A row that is already stamped keeps its
 * first time. `updated_at` is left alone, so retention still counts from when
 * the row failed.
 */
export async function markHandedOff(ids: number[], now: number): Promise<void> {
  if (ids.length === 0) return;

  await run(
    `UPDATE outbox SET handed_off_at = ?
     WHERE id IN (${ids.map(() => "?").join(", ")})
       AND status = 'failed' AND handed_off_at IS NULL`,
    [now, ...ids],
  );
}

/**
 * The conversation's rows left `sending` by an object that ended mid-attempt.
 * The caller holds the lock in a fresh object, so no attempt is alive.
 */
export async function interruptedRows(
  ref: ConversationRef,
): Promise<OutboxRow[]> {
  return getAll<OutboxRow>(
    `SELECT * FROM outbox
     WHERE status = 'sending'
       AND tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );
}

/** Conversations of open tenants with a row left `sending`, for the sweep to wake. */
export async function conversationsWithInterruptedSends(): Promise<
  ConversationRef[]
> {
  return (
    await getAll<{
      tenant_id: string;
      channel_account_id: string;
      phone_number: string;
    }>(
      `SELECT DISTINCT tenant_id, channel_account_id, phone_number FROM outbox
       WHERE status = 'sending' AND ${openTenantsOnly()}`,
    )
  ).map((row) => ({
    tenantId: row.tenant_id,
    channelAccountId: row.channel_account_id,
    phoneNumber: row.phone_number,
  }));
}

/** Delete final rows past the retention window. */
export async function purgeFinishedOutbox(
  now: number = Date.now(),
): Promise<number> {
  const purged = (
    await run(
      `DELETE FROM outbox
       WHERE status IN ('sent', 'failed', 'cancelled') AND updated_at < ?`,
      [now - OUTBOX_RETENTION_MS],
    )
  ).changes;

  if (purged > 0) logger.info({ purged }, "Purged outbox rows past retention");

  return purged;
}
