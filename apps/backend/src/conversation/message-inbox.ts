import type { ConversationRef, IncomingMessage } from "@vendeya/types";
import { type Compilable, sql } from "kysely";
import {
  batch,
  db,
  inActiveChannelAccounts,
  inOpenTenants,
  withoutTenantScope,
} from "../db/index.ts";

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
  const row = await withoutTenantScope("Meta message id is globally unique")
    .selectFrom("message_inbox")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("message_id", "=", messageId)
    .executeTakeFirst();

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
  const quotedContextJson = message.quotedContext
    ? JSON.stringify(message.quotedContext)
    : null;

  await db
    .insertInto("message_inbox")
    .values({
      tenant_id: ref.tenantId,
      channel_account_id: ref.channelAccountId,
      phone_number: ref.phoneNumber,
      message_text: message.body,
      message_id: message.id,
      whatsapp_timestamp: message.timestamp,
      created_at: Date.now(),
      quoted_message_context: quotedContextJson,
    })
    .onConflict((oc) => oc.column("message_id").doNothing())
    .execute();
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
  const group = await db
    .with("pending", (qb) =>
      qb
        .selectFrom("message_inbox")
        .selectAll()
        .where("status", "=", "pending")
        .where("tenant_id", "=", ref.tenantId)
        .where("channel_account_id", "=", ref.channelAccountId)
        .where("phone_number", "=", ref.phoneNumber)
        .where(inOpenTenants)
        .where((eb) =>
          inActiveChannelAccounts(
            eb,
            "channel_account_id",
            "message_inbox.tenant_id",
          ),
        )
        .orderBy("id"),
    )
    .selectFrom("pending")
    .select((eb) => [
      eb.fn.countAll<number>().as("count"),
      eb.fn.agg<string | null>("group_concat", ["id"]).as("ids"),
      eb.fn
        .agg<string | null>("group_concat", [eb.ref("message_text"), sql`' '`])
        .as("aggregated_text"),
      eb.fn.min<number | null>("whatsapp_timestamp").as("oldest_timestamp"),
      eb
        .selectFrom("pending")
        .select("message_id")
        .orderBy("id", "desc")
        .limit(1)
        .as("latest_message_id"),
      eb.fn
        .max<string | null>("quoted_message_context")
        .as("quoted_message_context"),
      eb.fn.max<number>("attempts").as("attempts"),
      eb.fn.min<number>("created_at").as("first_at"),
      eb.fn.max<number>("created_at").as("last_at"),
    ])
    .$castTo<AggregatedGroup & { count: number }>()
    .executeTakeFirst();

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
    await db
      .selectFrom("message_inbox")
      .select(["tenant_id", "channel_account_id", "phone_number"])
      .distinct()
      .where((eb) =>
        eb.or([
          eb.and([
            eb("status", "=", "pending"),
            eb("created_at", "<", now - QUIET_WINDOW_MS),
          ]),
          eb("status", "=", "processing"),
        ]),
      )
      .where(inOpenTenants)
      .where((eb) =>
        inActiveChannelAccounts(
          eb,
          "channel_account_id",
          "message_inbox.tenant_id",
        ),
      )
      .execute(),
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

  await withoutTenantScope("message_inbox rows keyed by id")
    .updateTable("message_inbox")
    .set({ status: "processing" })
    .where("id", "in", idList.map(Number))
    .execute();
}

/** Put a group whose reply is still owed back on the queue. */
export async function markAsPending(ids: string): Promise<void> {
  const idList = ids.split(",").map((id) => id.trim());

  await withoutTenantScope("message_inbox rows keyed by id")
    .updateTable("message_inbox")
    .set({ status: "pending" })
    .where("id", "in", idList.map(Number))
    .execute();
}

/**
 * Settles the rows of a turn that sent its reply, in the batch that persists
 * the turn. It is the only way a row becomes `processed`.
 */
export function markAsProcessed(ids: string): Compilable {
  const idList = ids.split(",").map((id) => id.trim());

  return withoutTenantScope("message_inbox rows keyed by id")
    .updateTable("message_inbox")
    .set({ status: "processed", processed_at: Date.now() })
    .where("id", "in", idList.map(Number));
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
  const attempts = groupAttempts + 1;
  const last = attempts >= MAX_TURN_ATTEMPTS;
  const status = last ? "failed" : "pending";

  const statements: Compilable[] = [
    db
      .updateTable("message_inbox")
      .set({ attempts, last_error: error, status })
      .where("tenant_id", "=", ref.tenantId)
      .where("status", "=", "processing")
      .where("id", "in", idList.map(Number)),
  ];

  if (last) {
    statements.push(
      db
        .updateTable("message_inbox")
        .set({ attempts, last_error: error, status: "failed" })
        .where("status", "=", "pending")
        .where("tenant_id", "=", ref.tenantId)
        .where("channel_account_id", "=", ref.channelAccountId)
        .where("phone_number", "=", ref.phoneNumber),
    );
  }

  await batch(statements);
}

/**
 * Settles the conversation's rows left `processing` by a turn that ended
 * mid-run, whether the object died with it or the write that records the
 * outcome threw. The caller holds the conversation lock, so no turn is
 * alive. The dead turn counts as one attempt, on the rows' highest count.
 * When that is the last attempt, the conversation's `pending` rows fail with
 * it.
 */
export async function recoverInterruptedTurns(
  ref: ConversationRef,
): Promise<number> {
  return Number(
    (
      await db
        .updateTable("message_inbox")
        .from((qb) =>
          qb
            .selectFrom("message_inbox")
            .select(sql<number>`max(attempts) + 1`.as("attempts"))
            .where("status", "=", "processing")
            .where("tenant_id", "=", ref.tenantId)
            .where("channel_account_id", "=", ref.channelAccountId)
            .where("phone_number", "=", ref.phoneNumber)
            .as("turn"),
        )
        .set({
          attempts: sql`turn.attempts`,
          last_error: INTERRUPTED_TURN,
          status: sql`CASE WHEN turn.attempts >= ${MAX_TURN_ATTEMPTS} THEN 'failed' ELSE 'pending' END`,
        })
        .where("turn.attempts", "is not", null)
        .where("message_inbox.tenant_id", "=", ref.tenantId)
        .where("message_inbox.channel_account_id", "=", ref.channelAccountId)
        .where("message_inbox.phone_number", "=", ref.phoneNumber)
        .where((eb) =>
          eb.or([
            eb("message_inbox.status", "=", "processing"),
            eb.and([
              eb("message_inbox.status", "=", "pending"),
              eb("turn.attempts", ">=", MAX_TURN_ATTEMPTS),
            ]),
          ]),
        )
        .executeTakeFirst()
    ).numUpdatedRows,
  );
}

export type FailedTurn = {
  id: number;
  last_error: string | null;
};

/** Returns unhanded `failed` rows for a conversation, oldest first. */
export async function unhandedFailedTurns(
  ref: ConversationRef,
): Promise<FailedTurn[]> {
  return await db
    .selectFrom("message_inbox")
    .select(["id", "last_error"])
    .where("status", "=", "failed")
    .where("handed_off_at", "is", null)
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .orderBy("id")
    .execute();
}

/**
 * The conversations that own a `failed` row no handoff has covered. A suspended
 * tenant's rows wait for it to reopen.
 */
export async function conversationsWithFailedTurns(): Promise<
  ConversationRef[]
> {
  return refsOf(
    await db
      .selectFrom("message_inbox")
      .select(["tenant_id", "channel_account_id", "phone_number"])
      .distinct()
      .where("status", "=", "failed")
      .where("handed_off_at", "is", null)
      .where(inOpenTenants)
      .execute(),
  );
}

/** Stamps the handoff on `failed` rows. A stamped row keeps its first time. */
export async function markTurnsHandedOff(
  ids: number[],
  now: number,
): Promise<void> {
  if (ids.length === 0) return;

  await withoutTenantScope("message_inbox rows keyed by id")
    .updateTable("message_inbox")
    .set({ handed_off_at: now })
    .where("id", "in", ids)
    .where("status", "=", "failed")
    .where("handed_off_at", "is", null)
    .execute();
}

/** Delete processed inbox rows processed before `before` (epoch ms). */
export async function purgeProcessedInbox(before: number): Promise<number> {
  return Number(
    (
      await withoutTenantScope("retention delete spans every tenant")
        .deleteFrom("message_inbox")
        .where("status", "=", "processed")
        .where("processed_at", "<", before)
        .executeTakeFirst()
    ).numDeletedRows,
  );
}
