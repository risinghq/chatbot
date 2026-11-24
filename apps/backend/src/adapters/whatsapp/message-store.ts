import { newId } from "@vendeya/utils";
import type { ConversationRef } from "@vendeya/types";
import type {
  ConversationMessage,
  MessageDirection,
  StoredMessageType,
} from "./types.ts";
import { sql } from "kysely";
import { db } from "../../db/index.ts";

/**
 * Message history is keyed by the full conversation identity, so the same
 * contact number writing to two businesses keeps two separate threads.
 */
export const MessageStore = {
  logStatement(
    id: string,
    ref: ConversationRef,
    direction: MessageDirection,
    type: StoredMessageType,
    content: string,
    status: string = "sent",
    whatsappMessageId?: string,
    productId?: string,
  ) {
    return db.insertInto("messages").values({
      id,
      tenant_id: ref.tenantId,
      channel_account_id: ref.channelAccountId,
      phone_number: ref.phoneNumber,
      direction,
      type,
      content,
      status,
      whatsapp_message_id: whatsappMessageId ?? null,
      product_id: productId ?? null,
    });
  },

  async log(
    ref: ConversationRef,
    direction: MessageDirection,
    type: StoredMessageType,
    content: string,
    status: string = "sent",
    whatsappMessageId?: string,
    productId?: string,
  ): Promise<string> {
    const id = newId();
    await this.logStatement(
      id,
      ref,
      direction,
      type,
      content,
      status,
      whatsappMessageId,
      productId,
    ).execute();

    // The outbox row keeps this id, so a retry moves this row rather than
    // writing a second one for the same reply.
    return id;
  },

  async findProductByMessageId(
    ref: ConversationRef,
    whatsappMessageId: string,
  ): Promise<string | null> {
    const result = await db
      .selectFrom("messages")
      .select("product_id")
      .where("whatsapp_message_id", "=", whatsappMessageId)
      .where("tenant_id", "=", ref.tenantId)
      .where("channel_account_id", "=", ref.channelAccountId)
      .executeTakeFirst();
    return result?.product_id ?? null;
  },

  async getMessageById(
    ref: ConversationRef,
    whatsappMessageId: string,
  ): Promise<ConversationMessage | null> {
    return (
      (await db
        .selectFrom("messages")
        .selectAll()
        .where("whatsapp_message_id", "=", whatsappMessageId)
        .where("tenant_id", "=", ref.tenantId)
        .where("channel_account_id", "=", ref.channelAccountId)
        .$castTo<ConversationMessage>()
        .executeTakeFirst()) ?? null
    );
  },

  async getHistory(
    ref: ConversationRef,
    limit: number = 50,
  ): Promise<ConversationMessage[]> {
    return await db
      .selectFrom("messages")
      .selectAll()
      .where("tenant_id", "=", ref.tenantId)
      .where("channel_account_id", "=", ref.channelAccountId)
      .where("phone_number", "=", ref.phoneNumber)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid desc`)
      .limit(limit)
      .$castTo<ConversationMessage>()
      .execute();
  },

  async clear(ref: ConversationRef): Promise<void> {
    await db
      .deleteFrom("messages")
      .where("tenant_id", "=", ref.tenantId)
      .where("channel_account_id", "=", ref.channelAccountId)
      .where("phone_number", "=", ref.phoneNumber)
      .execute();
  },
};
