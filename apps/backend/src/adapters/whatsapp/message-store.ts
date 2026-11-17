import type { ConversationRef } from "@vendeya/types";
import type {
  ConversationMessage,
  MessageDirection,
  StoredMessageType,
} from "./types.ts";
import { getAll, getOne, run } from "../../db/index.ts";

/**
 * Message history is keyed by the full conversation identity, so the same
 * contact number writing to two businesses keeps two separate threads.
 */
export const MessageStore = {
  async log(
    ref: ConversationRef,
    direction: MessageDirection,
    type: StoredMessageType,
    content: string,
    status: string = "sent",
    whatsappMessageId?: string,
    productId?: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await run(
      `INSERT INTO messages (id, tenant_id, channel_account_id, phone_number, direction, type, content, status, whatsapp_message_id, product_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        ref.tenantId,
        ref.channelAccountId,
        ref.phoneNumber,
        direction,
        type,
        content,
        status,
        whatsappMessageId ?? null,
        productId ?? null,
      ],
    );

    // The outbox row keeps this id, so a retry moves this row rather than
    // writing a second one for the same reply.
    return id;
  },

  async findProductByMessageId(
    ref: ConversationRef,
    whatsappMessageId: string,
  ): Promise<string | null> {
    const result = await getOne<{ product_id: string | null }>(
      `SELECT product_id FROM messages
       WHERE whatsapp_message_id = ? AND tenant_id = ? AND channel_account_id = ?`,
      [whatsappMessageId, ref.tenantId, ref.channelAccountId],
    );
    return result?.product_id ?? null;
  },

  async getMessageById(
    ref: ConversationRef,
    whatsappMessageId: string,
  ): Promise<ConversationMessage | null> {
    return (
      (await getOne<ConversationMessage>(
        `SELECT * FROM messages
         WHERE whatsapp_message_id = ? AND tenant_id = ? AND channel_account_id = ?`,
        [whatsappMessageId, ref.tenantId, ref.channelAccountId],
      )) ?? null
    );
  },

  async getHistory(
    ref: ConversationRef,
    limit: number = 50,
  ): Promise<ConversationMessage[]> {
    return await getAll<ConversationMessage>(
      `SELECT * FROM messages
       WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
       ORDER BY created_at DESC, ROWID DESC
       LIMIT ?`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber, limit],
    );
  },

  async clear(ref: ConversationRef): Promise<void> {
    await run(
      `DELETE FROM messages
       WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    );
  },
};
