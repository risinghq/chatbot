import type { ConversationRef } from "@vendeya/types";
import { db } from "../db/index.ts";

/*
 * `unread_alerts` suppresses repeated alerts until the holder answers. The row
 * is written before delivery and `notify` removes it when delivery fails.
 */

/** Records that the holder has an unanswered alert. */
export async function raiseUnreadAlert(ref: ConversationRef): Promise<void> {
  await db
    .insertInto("unread_alerts")
    .values({
      tenant_id: ref.tenantId,
      channel_account_id: ref.channelAccountId,
      phone_number: ref.phoneNumber,
      alerted_at: Date.now(),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/**
 * The holder answered, or the alert was not delivered. A change of the assigned
 * agent clears the row in the database, not here.
 */
export async function clearUnreadAlert(ref: ConversationRef): Promise<void> {
  await db
    .deleteFrom("unread_alerts")
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .execute();
}

/**
 * Claims the alert for a customer message only when an assigned agent has a
 * phone number and no alert already represents the conversation.
 */
export async function claimMessageAlert(
  ref: ConversationRef,
): Promise<boolean> {
  const claimed = await db
    .insertInto("unread_alerts")
    .columns(["tenant_id", "channel_account_id", "phone_number", "alerted_at"])
    .expression((eb) =>
      eb
        .selectFrom("conversations as c")
        .innerJoin("users as u", "u.id", "c.assigned_agent")
        .select([
          "c.tenant_id",
          "c.channel_account_id",
          "c.phone_number",
          eb.val(Date.now()).as("alerted_at"),
        ])
        .where("c.tenant_id", "=", ref.tenantId)
        .where("c.channel_account_id", "=", ref.channelAccountId)
        .where("c.phone_number", "=", ref.phoneNumber)
        .where("c.status", "=", "human_takeover")
        .where("u.phone_number", "is not", null)
        .where("u.phone_number", "<>", ""),
    )
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();

  return claimed.numInsertedOrUpdatedRows === 1n;
}
