import type { ConversationRef } from "@vendeya/types";
import { run } from "../db/index.ts";

/*
 * `unread_alerts` suppresses repeated alerts until the holder answers. The row
 * is written before delivery and `notify` removes it when delivery fails.
 */

const IDENTITY_WHERE =
  "tenant_id = ? AND channel_account_id = ? AND phone_number = ?";

function identityParams(ref: ConversationRef): [string, string, string] {
  return [ref.tenantId, ref.channelAccountId, ref.phoneNumber];
}

/** Records that the holder has an unanswered alert. */
export async function raiseUnreadAlert(ref: ConversationRef): Promise<void> {
  await run(
    `INSERT OR IGNORE INTO unread_alerts
       (tenant_id, channel_account_id, phone_number, alerted_at)
     VALUES (?, ?, ?, ?)`,
    [...identityParams(ref), Date.now()],
  );
}

/**
 * The holder answered, or the alert was not delivered. A change of the assigned
 * agent clears the row in the database, not here.
 */
export async function clearUnreadAlert(ref: ConversationRef): Promise<void> {
  await run(
    `DELETE FROM unread_alerts WHERE ${IDENTITY_WHERE}`,
    identityParams(ref),
  );
}

/**
 * Claims the alert for a customer message only when an assigned agent has a
 * phone number and no alert already represents the conversation.
 */
export async function claimMessageAlert(
  ref: ConversationRef,
): Promise<boolean> {
  const claimed = await run(
    `INSERT OR IGNORE INTO unread_alerts
         (tenant_id, channel_account_id, phone_number, alerted_at)
       SELECT c.tenant_id, c.channel_account_id, c.phone_number, ?
       FROM conversations c
       JOIN users u ON u.id = c.assigned_agent
       WHERE c.tenant_id = ? AND c.channel_account_id = ?
         AND c.phone_number = ?
         AND c.status = 'human_takeover'
         AND COALESCE(u.phone_number, '') <> ''`,
    [Date.now(), ...identityParams(ref)],
  );

  return claimed.changes > 0;
}
