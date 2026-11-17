import type { Result } from "../../../shared/result/index.ts";
import { Ok, Err } from "../../../shared/result/index.ts";
import { tenantPredicate } from "../../../db/query.ts";
import { getAll, getOne } from "../../../db/index.ts";

export type WaitingConversation = {
  tenant_id: string;
  channel_account_id: string;
  phone_number: string;
  context_data: string;
};

/**
 * Conversations stuck waiting for a provider to come back. `tenantId` null
 * spans tenants, which is what the platform-wide retry sweep wants.
 */
export async function getWaitingConversations(
  tenantId: string | null = null,
): Promise<Result<WaitingConversation[], Error>> {
  try {
    const rows = await getAll<WaitingConversation>(
      `SELECT tenant_id, channel_account_id, phone_number, context_data
       FROM conversations
       WHERE current_state = 'waiting_for_recovery'
         AND ${tenantPredicate(tenantId)}`,
      tenantId ? [tenantId] : [],
    );

    return Ok(rows);
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function countWaitingForRecovery(
  tenantId: string | null = null,
): Promise<number> {
  const result = await getOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM conversations
     WHERE current_state = 'waiting_for_recovery'
       AND ${tenantPredicate(tenantId)}`,
    tenantId ? [tenantId] : [],
  );

  return result?.count ?? 0;
}
