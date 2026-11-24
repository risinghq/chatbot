import { createLogger } from "../lib/logger.ts";
import type { ConversationRef } from "@vendeya/types";
import type {
  OutboundMessage,
  SendOutcome,
} from "../adapters/whatsapp/types.ts";
import type { Compilable } from "kysely";
import {
  batch,
  db,
  inActiveChannelAccounts,
  inOpenTenants,
  withoutTenantScope,
} from "../db/index.ts";

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
  type: "text" | "image" | "template";
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
  const row = await db
    .selectFrom("outbox")
    .select("id")
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .where("status", "in", ["pending", "sending"])
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Append a reply to the conversation's queue. `id` gives the order it goes out in. */
export function outboxInsert(args: {
  ref: ConversationRef;
  messageId: string;
  message: OutboundMessage;
  state: OutboxStep;
  now: number;
}) {
  const { ref, messageId, message, state, now } = args;

  return db.insertInto("outbox").values({
    tenant_id: ref.tenantId,
    channel_account_id: ref.channelAccountId,
    phone_number: ref.phoneNumber,
    message_id: messageId,
    type: message.type,
    content: message.content,
    caption:
      message.type === "image"
        ? (message.caption ?? null)
        : message.type === "template"
          ? JSON.stringify(message.template)
          : null,
    status: state.status,
    attempts: state.attempts,
    ambiguous_attempts: state.ambiguousAttempts,
    last_kind: state.lastKind,
    last_reason: state.lastReason,
    next_attempt_at: state.nextAttemptAt,
    created_at: now,
    updated_at: now,
  });
}

export async function enqueue(args: {
  ref: ConversationRef;
  messageId: string;
  message: OutboundMessage;
  state: OutboxStep;
  now: number;
}): Promise<number> {
  const result = await outboxInsert(args).executeTakeFirstOrThrow();
  return Number(result.insertId);
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
  if (row.type === "template") {
    // `content` is the rendered body the thread shows; the send payload is in
    // `caption` as JSON.
    return {
      type: "template",
      content: row.content,
      template: JSON.parse(row.caption ?? "{}"),
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
  return await db
    .selectFrom("outbox")
    .selectAll()
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .where("status", "in", ["pending", "sending"])
    .where(inOpenTenants)
    .orderBy("id")
    .limit(1)
    .executeTakeFirst();
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
    await withoutTenantScope("outbox row keyed by id")
      .updateTable("outbox")
      .set({ status: "sending", updated_at: now })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .executeTakeFirst()
  ).numUpdatedRows;

  if (changed !== 1n) return undefined;

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
    withoutTenantScope("outbox row keyed by id")
      .updateTable("outbox")
      .set({
        status: step.status,
        attempts: step.attempts,
        ambiguous_attempts: step.ambiguousAttempts,
        last_kind: step.lastKind,
        last_reason: step.lastReason,
        next_attempt_at: step.nextAttemptAt,
        updated_at: now,
      })
      .where("id", "=", row.id),
    withoutTenantScope("message keyed by id")
      .updateTable("messages")
      .set({
        status: messageStatus(step.status),
        whatsapp_message_id: outcome.ok ? outcome.messageId : null,
      })
      .where("id", "=", row.message_id),
  ]);

  return step;
}

/**
 * Put a claimed row back without counting an attempt. The number the
 * conversation runs on was switched off, which no attempt could have fixed.
 */
export async function deferUnavailable(id: number, now: number): Promise<void> {
  await withoutTenantScope("outbox row keyed by id")
    .updateTable("outbox")
    .set({
      status: "pending",
      next_attempt_at: now + CHANNEL_UNAVAILABLE_DELAY_MS,
      updated_at: now,
    })
    .where("id", "=", id)
    .where("status", "=", "sending")
    .execute();
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

  const [, expired] = await batch([
    db
      .updateTable("messages")
      .set({ status: "failed" })
      .where("tenant_id", "=", ref.tenantId)
      .where("id", "in", (eb) =>
        eb
          .selectFrom("outbox")
          .select("message_id")
          .where("tenant_id", "=", ref.tenantId)
          .where("channel_account_id", "=", ref.channelAccountId)
          .where("phone_number", "=", ref.phoneNumber)
          .where("status", "=", "pending")
          .where("created_at", "<=", cutoff)
          .where(inOpenTenants),
      ),
    db
      .updateTable("outbox")
      .set({ status: "failed", last_reason: "expired", updated_at: now })
      .where("tenant_id", "=", ref.tenantId)
      .where("channel_account_id", "=", ref.channelAccountId)
      .where("phone_number", "=", ref.phoneNumber)
      .where("status", "=", "pending")
      .where("created_at", "<=", cutoff)
      .where(inOpenTenants),
  ]);

  return Number(expired!.meta.changes);
}

/**
 * Drop the replies the bot had queued, because a person now owns the
 * conversation or is being given it. Only `pending` rows: the caller holds the
 * conversation lock, so no attempt can be in flight. The outbox update comes
 * last, so its `meta.changes` is how many were dropped.
 */
export function cancelPendingStatements(ref: ConversationRef): Compilable[] {
  return [
    db
      .updateTable("messages")
      .set({ status: "cancelled" })
      .where("tenant_id", "=", ref.tenantId)
      .where("id", "in", (eb) =>
        eb
          .selectFrom("outbox")
          .select("message_id")
          .where("tenant_id", "=", ref.tenantId)
          .where("channel_account_id", "=", ref.channelAccountId)
          .where("phone_number", "=", ref.phoneNumber)
          .where("status", "=", "pending"),
      ),
    db
      .updateTable("outbox")
      .set({ status: "cancelled", updated_at: Date.now() })
      .where("tenant_id", "=", ref.tenantId)
      .where("channel_account_id", "=", ref.channelAccountId)
      .where("phone_number", "=", ref.phoneNumber)
      .where("status", "=", "pending"),
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
  const row = await db
    .selectNoFrom((eb) => [
      eb
        .selectFrom("outbox")
        .select("next_attempt_at")
        .where("tenant_id", "=", ref.tenantId)
        .where("channel_account_id", "=", ref.channelAccountId)
        .where("phone_number", "=", ref.phoneNumber)
        .where("status", "in", ["pending", "sending"])
        .where((eb) =>
          inActiveChannelAccounts(eb, "channel_account_id", "outbox.tenant_id"),
        )
        .orderBy("id")
        .limit(1)
        .as("due"),
      eb
        .selectFrom("outbox")
        .select((eb) => eb.fn.min("created_at").as("stale"))
        .where("tenant_id", "=", ref.tenantId)
        .where("channel_account_id", "=", ref.channelAccountId)
        .where("phone_number", "=", ref.phoneNumber)
        .where("status", "=", "pending")
        .as("stale"),
    ])
    .where((eb) =>
      eb(
        eb.val(ref.tenantId),
        "in",
        eb.selectFrom("tenants").select("id").where("status", "=", "active"),
      ),
    )
    .executeTakeFirst();
  const times = [
    row?.due,
    row?.stale != null ? row.stale + MAX_AGE_MS : null,
  ].filter((time): time is number => typeof time === "number");
  return times.length === 0 ? undefined : Math.min(...times);
}

/**
 * The conversations the sweep wakes: those with a row past the age limit, and
 * those whose head row is due on a number that can send.
 */
export async function conversationsNeedingOutbox(
  now: number,
): Promise<ConversationRef[]> {
  const stale = await db
    .selectFrom("outbox")
    .select(["tenant_id", "channel_account_id", "phone_number"])
    .distinct()
    .where("status", "=", "pending")
    .where("created_at", "<=", now - MAX_AGE_MS)
    .where(inOpenTenants)
    .execute();

  const due = await db
    .selectFrom("outbox as o")
    .select(["o.tenant_id", "o.channel_account_id", "o.phone_number"])
    .where("o.status", "=", "pending")
    .where("o.next_attempt_at", "<=", now)
    .where("o.id", "=", (eb) =>
      eb
        .selectFrom("outbox as head")
        .select((eb) => eb.fn.min("head.id").as("id"))
        .whereRef("head.tenant_id", "=", "o.tenant_id")
        .whereRef("head.channel_account_id", "=", "o.channel_account_id")
        .whereRef("head.phone_number", "=", "o.phone_number")
        .where("head.status", "in", ["pending", "sending"]),
    )
    .where((eb) => inOpenTenants(eb, "o.tenant_id"))
    .where((eb) =>
      inActiveChannelAccounts(eb, "o.channel_account_id", "o.tenant_id"),
    )
    .execute();

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
  return await db
    .selectFrom("outbox")
    .selectAll()
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .where("status", "=", "failed")
    .where("handed_off_at", "is", null)
    .orderBy("id")
    .execute();
}

/**
 * The conversations that own a `failed` row no handoff has covered. A suspended
 * tenant's rows wait for it to reopen.
 */
export async function conversationsAwaitingHandoff(): Promise<
  ConversationRef[]
> {
  return (
    await db
      .selectFrom("outbox")
      .select(["tenant_id", "channel_account_id", "phone_number"])
      .distinct()
      .where("status", "=", "failed")
      .where("handed_off_at", "is", null)
      .where(inOpenTenants)
      .execute()
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

  await withoutTenantScope("outbox rows keyed by id")
    .updateTable("outbox")
    .set({ handed_off_at: now })
    .where("id", "in", ids)
    .where("status", "=", "failed")
    .where("handed_off_at", "is", null)
    .execute();
}

/**
 * The conversation's rows left `sending` by an object that ended mid-attempt.
 * The caller holds the lock in a fresh object, so no attempt is alive.
 */
export async function interruptedRows(
  ref: ConversationRef,
): Promise<OutboxRow[]> {
  return db
    .selectFrom("outbox")
    .selectAll()
    .where("status", "=", "sending")
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .execute();
}

/** Conversations of open tenants with a row left `sending`, for the sweep to wake. */
export async function conversationsWithInterruptedSends(): Promise<
  ConversationRef[]
> {
  return (
    await db
      .selectFrom("outbox")
      .select(["tenant_id", "channel_account_id", "phone_number"])
      .distinct()
      .where("status", "=", "sending")
      .where(inOpenTenants)
      .execute()
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
  const purged = Number(
    (
      await withoutTenantScope("retention delete spans every tenant")
        .deleteFrom("outbox")
        .where("status", "in", ["sent", "failed", "cancelled"])
        .where("updated_at", "<", now - OUTBOX_RETENTION_MS)
        .executeTakeFirst()
    ).numDeletedRows,
  );

  if (purged > 0) logger.info({ purged }, "Purged outbox rows past retention");

  return purged;
}
