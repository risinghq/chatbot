import {
  activeChannelAccountsOnly,
  openTenantsOnly,
  tenantPredicate,
} from "../db/query.ts";
import type { ConversationRef, IncomingMessage } from "@vendeya/types";
import { getAll, getOne, run, stmt } from "../db/index.ts";

/*
 * A row is processed in the batch that persists its turn, or failed after
 * `MAX_TURN_ATTEMPTS`. Throws and interrupted turns count attempts. A busy lock
 * does not. `handoff.ts` alerts for an unstamped failure.
 */

/** Turns a group gets before it is handed to a person. */
export const MAX_TURN_ATTEMPTS = 2;

/** The `last_error` of a row whose turn ended with the object running it. */
export const INTERRUPTED_TURN = "interrupted: the turn ended mid-run";

/** A group is answered once its newest message is this old. */
export const QUIET_WINDOW_MS = 2_000;

/** A group is answered once its oldest message is this old, however often the customer writes. */
export const MAX_BATCH_WAIT_MS = 10_000;

/** The pending messages of one conversation, joined into one turn. */
export type AggregatedGroup = {
  ids: string;
  aggregated_text: string;
  oldest_timestamp: number;
  latest_message_id: string;
  quoted_message_context: string | null;
  /** The most failed turns any row of the group has had. */
  attempts: number;
  first_at: number;
  last_at: number;
};

/** Whether this Meta message id is already on the queue, processed or not. */
export async function isQueued(messageId: string): Promise<boolean> {
  const row = await getOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM message_inbox WHERE message_id = ?",
    [messageId],
  );

  return (row?.count ?? 0) > 0;
}

/**
 * Queue an inbound message for aggregation. The Meta message id is unique, so a
 * redelivery of the same message is ignored rather than raising. Meta resends a
 * whole batch when the webhook answers 5xx.
 */
export async function storeIncomingMessage(
  ref: ConversationRef,
  message: IncomingMessage,
): Promise<void> {
  const now = Date.now();
  const quotedContextJson = message.quotedContext
    ? JSON.stringify(message.quotedContext)
    : null;

  await run(
    `INSERT INTO message_inbox (tenant_id, channel_account_id, phone_number, message_text, message_id, whatsapp_timestamp, created_at, quoted_message_context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO NOTHING`,
    [
      ref.tenantId,
      ref.channelAccountId,
      ref.phoneNumber,
      message.body,
      message.id,
      message.timestamp,
      now,
      quotedContextJson,
    ],
  );
}

/**
 * The conversation's pending messages, joined in arrival order, or undefined
 * when it has none it may answer. A suspended tenant or a number that is not
 * active keeps its rows pending, so reactivating either resumes them. The
 * webhook refuses only new inbound, so suspension must also stop messages
 * queued before it.
 */
export async function pendingGroup(
  ref: ConversationRef,
): Promise<AggregatedGroup | undefined> {
  const group = await getOne<AggregatedGroup & { count: number }>(
    `WITH pending AS (
       SELECT * FROM message_inbox
       WHERE status = 'pending'
         AND tenant_id = ? AND channel_account_id = ? AND phone_number = ?
         AND ${openTenantsOnly()}
         AND ${activeChannelAccountsOnly()}
       ORDER BY id
     )
     SELECT
       COUNT(*) AS count,
       GROUP_CONCAT(id) AS ids,
       GROUP_CONCAT(message_text, ' ') AS aggregated_text,
       MIN(whatsapp_timestamp) AS oldest_timestamp,
       (SELECT message_id FROM pending ORDER BY id DESC LIMIT 1)
         AS latest_message_id,
       MAX(quoted_message_context) AS quoted_message_context,
       MAX(attempts) AS attempts,
       MIN(created_at) AS first_at,
       MAX(created_at) AS last_at
     FROM pending`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );

  return group && group.count > 0 ? group : undefined;
}

/**
 * When a group may be answered: a quiet window after its newest message, so
 * messages sent close together become one turn, and never later than the cap
 * after its oldest.
 */
export function groupReadyAt(group: AggregatedGroup): number {
  return Math.min(
    group.last_at + QUIET_WINDOW_MS,
    group.first_at + MAX_BATCH_WAIT_MS,
  );
}

/**
 * Conversations of open tenants with a pending message past its quiet window,
 * or a row still `processing`. The sweep wakes them in case the wake that
 * should have answered them was lost.
 */
export async function conversationsWithWaitingMessages(
  now: number,
): Promise<ConversationRef[]> {
  return refsOf(
    await getAll<IdentityRow>(
      `SELECT DISTINCT tenant_id, channel_account_id, phone_number
       FROM message_inbox
       WHERE ((status = 'pending' AND created_at < ?) OR status = 'processing')
         AND ${openTenantsOnly()}
         AND ${activeChannelAccountsOnly()}`,
      [now - QUIET_WINDOW_MS],
    ),
  );
}

type IdentityRow = {
  tenant_id: string;
  channel_account_id: string;
  phone_number: string;
};

function refsOf(rows: IdentityRow[]): ConversationRef[] {
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    channelAccountId: row.channel_account_id,
    phoneNumber: row.phone_number,
  }));
}

/** Takes the group out of the pending set while its turn runs. */
export async function markAsProcessing(ids: string): Promise<void> {
  const idList = ids.split(",").map((id) => id.trim());
  const placeholders = idList.map(() => "?").join(",");

  await run(
    `UPDATE message_inbox SET status = 'processing' WHERE id IN (${placeholders})`,
    idList,
  );
}

/** Put a group whose reply is still owed back on the queue. */
export async function markAsPending(ids: string): Promise<void> {
  const idList = ids.split(",").map((id) => id.trim());
  const placeholders = idList.map(() => "?").join(",");

  await run(
    `UPDATE message_inbox SET status = 'pending' WHERE id IN (${placeholders})`,
    idList,
  );
}

/**
 * Settles the rows of a turn that sent its reply, in the batch that persists
 * the turn. It is the only way a row becomes `processed`.
 */
export function markAsProcessed(ids: string): D1PreparedStatement {
  const idList = ids.split(",").map((id) => id.trim());
  const placeholders = idList.map(() => "?").join(",");

  return stmt(
    `UPDATE message_inbox
     SET status = 'processed', processed_at = ?
     WHERE id IN (${placeholders})`,
    [Date.now(), ...idList],
  );
}

/**
 * Counts a turn that ended without a reply. Attempts belong to the
 * conversation, not the row: `groupAttempts` is the most any row of the group
 * had when it was read. On the last attempt the statement also fails every
 * `pending` row that arrived while the turn ran, so none is answered after the
 * handoff.
 */
export async function recordFailedTurn(
  ref: ConversationRef,
  ids: string,
  groupAttempts: number,
  error: string,
): Promise<void> {
  const idList = ids.split(",").map((id) => id.trim());
  const placeholders = idList.map(() => "?").join(",");
  const attempts = groupAttempts + 1;
  const last = attempts >= MAX_TURN_ATTEMPTS;

  await run(
    `UPDATE message_inbox
     SET attempts = ?,
         last_error = ?,
         status = ?
     WHERE (id IN (${placeholders}) AND status = 'processing')
        OR (? AND status = 'pending'
            AND tenant_id = ? AND channel_account_id = ? AND phone_number = ?)`,
    [
      attempts,
      error,
      last ? "failed" : "pending",
      ...idList,
      last ? 1 : 0,
      ref.tenantId,
      ref.channelAccountId,
      ref.phoneNumber,
    ],
  );
}

/**
 * Settles the conversation's rows left `processing` by a turn that ended with
 * the object running it. The caller holds the conversation lock in a fresh
 * object, so no turn is alive. The dead turn counts as one attempt, on the
 * rows' highest count. When that is the last attempt, the conversation's
 * `pending` rows fail with it.
 */
export async function recoverInterruptedTurns(
  ref: ConversationRef,
): Promise<number> {
  const identity = [ref.tenantId, ref.channelAccountId, ref.phoneNumber];
  return (
    await run(
      `UPDATE message_inbox
       SET attempts = turn.attempts,
           last_error = ?,
           status = CASE WHEN turn.attempts >= ? THEN 'failed' ELSE 'pending' END
       FROM (
         SELECT MAX(attempts) + 1 AS attempts
         FROM message_inbox
         WHERE status = 'processing'
           AND tenant_id = ? AND channel_account_id = ? AND phone_number = ?
       ) AS turn
       WHERE turn.attempts IS NOT NULL
         AND message_inbox.tenant_id = ?
         AND message_inbox.channel_account_id = ?
         AND message_inbox.phone_number = ?
         AND (message_inbox.status = 'processing'
              OR (message_inbox.status = 'pending' AND turn.attempts >= ?))`,
      [
        INTERRUPTED_TURN,
        MAX_TURN_ATTEMPTS,
        ...identity,
        ...identity,
        MAX_TURN_ATTEMPTS,
      ],
    )
  ).changes;
}

export type FailedTurn = {
  id: number;
  last_error: string | null;
};

/** Returns unhanded `failed` rows for a conversation, oldest first. */
export async function unhandedFailedTurns(
  ref: ConversationRef,
): Promise<FailedTurn[]> {
  return await getAll<FailedTurn>(
    `SELECT id, last_error FROM message_inbox
     WHERE status = 'failed' AND handed_off_at IS NULL
       AND tenant_id = ? AND channel_account_id = ? AND phone_number = ?
     ORDER BY id`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );
}

/**
 * The conversations that own a `failed` row no handoff has covered. A suspended
 * tenant's rows wait for it to reopen.
 */
export async function conversationsWithFailedTurns(): Promise<
  ConversationRef[]
> {
  return refsOf(
    await getAll<IdentityRow>(
      `SELECT DISTINCT tenant_id, channel_account_id, phone_number
       FROM message_inbox
       WHERE status = 'failed' AND handed_off_at IS NULL AND ${openTenantsOnly()}`,
    ),
  );
}

/** Stamps the handoff on `failed` rows. A stamped row keeps its first time. */
export async function markTurnsHandedOff(
  ids: number[],
  now: number,
): Promise<void> {
  if (ids.length === 0) return;

  await run(
    `UPDATE message_inbox SET handed_off_at = ?
     WHERE id IN (${ids.map(() => "?").join(", ")})
       AND status = 'failed' AND handed_off_at IS NULL`,
    [now, ...ids],
  );
}

/** Queue depth. `tenantId` null counts across open tenants, as an unpinned platform operator reads it. */
export async function countPending(
  tenantId: string | null = null,
): Promise<number> {
  const rows = await getAll<{ count: number }>(
    `SELECT COUNT(*) as count FROM message_inbox
     WHERE status = 'pending' AND ${tenantPredicate(tenantId)}`,
    tenantId ? [tenantId] : [],
  );
  return rows[0]?.count ?? 0;
}

export async function countFailed(
  tenantId: string | null = null,
): Promise<number> {
  const rows = await getAll<{ count: number }>(
    `SELECT COUNT(*) as count FROM message_inbox
     WHERE status = 'failed' AND ${tenantPredicate(tenantId)}`,
    tenantId ? [tenantId] : [],
  );
  return rows[0]?.count ?? 0;
}

/** Delete processed inbox rows processed before `before` (epoch ms). */
export async function purgeProcessedInbox(before: number): Promise<number> {
  return (
    await run(
      "DELETE FROM message_inbox WHERE status = 'processed' AND processed_at < ?",
      [before],
    )
  ).changes;
}
