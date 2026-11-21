import type { Conversation, ConversationRef } from "@vendeya/types";
import { db } from "../db/index.ts";

/** A conversation row, without the customer name the API joins in. */
export type StoredConversation = Omit<Conversation, "customer_name">;

/** A hold nobody has written in for this long goes back to the assistant. */
const IDLE_HOLD_MS = 3 * 60 * 60 * 1000;

/** Narrows a conversations query to the one conversation `ref` names. */
export function byRef<Q extends { where: (...args: any[]) => Q }>(
  query: Q,
  ref: ConversationRef,
): Q {
  return query
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber);
}

export async function findConversation(
  ref: ConversationRef,
): Promise<StoredConversation | null> {
  const row = await byRef(
    db.selectFrom("conversations").selectAll(),
    ref,
  ).executeTakeFirst();
  return (row as StoredConversation | undefined) ?? null;
}

/** The conversation, created active the first time the contact writes. */
export async function ensureConversation(
  ref: ConversationRef,
  isSimulation = false,
): Promise<StoredConversation> {
  await db
    .insertInto("conversations")
    .values({
      tenant_id: ref.tenantId,
      channel_account_id: ref.channelAccountId,
      phone_number: ref.phoneNumber,
      status: "active",
      is_simulation: isSimulation ? 1 : 0,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return (await findConversation(ref))!;
}

/** Staff take the conversation over, for a caller's batch. */
export function handOffUpdate(ref: ConversationRef, reason: string) {
  return byRef(
    db.updateTable("conversations").set({
      status: "human_takeover",
      handover_reason: reason,
      last_activity_at: Date.now(),
    }),
    ref,
  );
}

export async function handOff(
  ref: ConversationRef,
  reason: string,
): Promise<void> {
  await handOffUpdate(ref, reason).execute();
}

/** Writes neither the status nor the agent, so it needs no lock. */
export function activityUpdate(ref: ConversationRef) {
  return byRef(
    db.updateTable("conversations").set({ last_activity_at: Date.now() }),
    ref,
  );
}

export async function refreshLastActivity(ref: ConversationRef): Promise<void> {
  await activityUpdate(ref).execute();
}

/**
 * Hands the conversation back to the assistant. A conversation a person had
 * taken loses its agent, because nobody holds a conversation the assistant
 * answers. An agent assigned to an assistant-owned conversation keeps it.
 */
export async function release(ref: ConversationRef): Promise<void> {
  await releaseQuery(ref).execute();
}

/**
 * Releases a held conversation nobody has written in for three hours, so a
 * customer is not left waiting on a hold staff stopped working. Returns
 * whether it did.
 */
export async function releaseIfIdle(ref: ConversationRef): Promise<boolean> {
  const result = await releaseQuery(ref)
    .where("status", "=", "human_takeover")
    .where("last_activity_at", "<", Date.now() - IDLE_HOLD_MS)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

function releaseQuery(ref: ConversationRef) {
  // SQLite evaluates every SET expression against the row before the update,
  // so the CASE tests the status the conversation had.
  return byRef(
    db.updateTable("conversations").set((eb) => ({
      assigned_agent: eb
        .case()
        .when("status", "=", "human_takeover")
        .then(null)
        .else(eb.ref("assigned_agent"))
        .end(),
      assignment_notified_at: eb
        .case()
        .when("status", "=", "human_takeover")
        .then(null)
        .else(eb.ref("assignment_notified_at"))
        .end(),
      status: "active",
      handover_reason: null,
      last_activity_at: Date.now(),
    })),
    ref,
  );
}

export function refOf(conv: StoredConversation): ConversationRef {
  return {
    tenantId: conv.tenant_id,
    channelAccountId: conv.channel_account_id,
    phoneNumber: conv.phone_number,
  };
}
