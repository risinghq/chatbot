import type { ConversationRef, ParamBinding } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { sql } from "kysely";
import { outboxRow, queuedBehind } from "../../conversation/outbox.ts";
import { messageRow } from "../../adapters/whatsapp/message-store.ts";
import {
  conversationRow,
  createConversationQuery,
} from "../../conversation/store.ts";
import { batch, db, tenantScope } from "../../db/index.ts";
import { isOptedOut, marketingCapCutoff } from "./consent.ts";

/**
 * The values `{{n}}` parameters resolve to, per recipient. Order fields are
 * empty when the send has no order behind it.
 */
export type ParamContext = {
  customer_name?: string | null;
  order_number?: string | null;
  order_total?: string | null;
  pay_link?: string | null;
};

/** Meta rejects an empty parameter and collapses whitespace runs. */
function clean(value: string | null | undefined): string {
  return (value ?? "").toString().replace(/\s+/g, " ").trim() || "-";
}

export function resolveParams(
  bindings: ParamBinding[],
  ctx: ParamContext,
): string[] {
  return bindings.map((b) =>
    b.kind === "text" ? clean(b.text) : clean(ctx[b.field]),
  );
}

/** The body with its `{{n}}` placeholders filled in, for the thread to show. */
export function renderBody(body: string, parameters: string[]): string {
  let i = 0;
  return body.replace(/\{\{\d+\}\}/g, () => parameters[i++] ?? "-");
}

/**
 * Writes the `messages` row and the outbox row a template send needs, and
 * returns the `messages` id, or the refusal reason when a marketing template
 * breaks consent: `"opted_out"` or `"capped"`. A campaign passes
 * `recipientId`, and that recipient is marked queued in the same transaction
 * as the send rows, so a send is never queued twice or recorded as skipped.
 * The conversation is created in the same batch when the contact has never
 * written, so a refused send leaves no row behind. The conversation's object
 * sends the row on its next wake, which the sweep's outbox check schedules.
 */
export async function enqueueTemplate(
  ref: ConversationRef,
  template: { name: string; language: string; body: string },
  bindings: ParamBinding[],
  ctx: ParamContext,
  now: number,
  marketingDays: number | null,
  recipientId?: string,
): Promise<string | "opted_out" | "capped"> {
  if (
    marketingDays !== null &&
    (await isOptedOut(ref.tenantId, ref.phoneNumber))
  ) {
    return "opted_out";
  }
  const messageId = newId();
  const parameters = resolveParams(bindings, ctx);
  const rendered = renderBody(template.body, parameters);
  const message = messageRow(
    messageId,
    ref,
    "outbound",
    "template",
    rendered,
    "queued",
  );
  const outbox = outboxRow({
    ref,
    messageId,
    message: {
      type: "template",
      content: rendered,
      template: {
        name: template.name,
        language: template.language,
        parameters,
      },
    },
    state: queuedBehind(now),
    now,
  });

  const marked = (claimedOnly: boolean) => {
    if (recipientId === undefined) return [];
    const update = db
      .updateTable("campaign_recipients")
      .set({ status: "queued", message_id: messageId, queued_at: now })
      .where(tenantScope(ref.tenantId))
      .where("id", "=", recipientId);
    return [
      claimedOnly
        ? update.where((eb) =>
            eb.exists(claim(ref, messageId).select(sql.lit(1).as("one"))),
          )
        : update,
    ];
  };

  if (marketingDays === null) {
    await batch([
      createConversationQuery(ref),
      db.insertInto("messages").values(message),
      db.insertInto("outbox").values(outbox),
      ...marked(false),
    ]);
    return messageId;
  }

  // One batch is one transaction. The upsert stamps this send's id only when
  // the phone is outside the window, and the later statements run only when
  // the stamp is this send's, so concurrent senders cannot both pass and a
  // claim never commits without its send rows.
  const results = await batch([
    db
      .insertInto("marketing_sends")
      .values({
        tenant_id: ref.tenantId,
        phone_number: ref.phoneNumber,
        sent_at: now,
        message_id: messageId,
      })
      .onConflict((oc) =>
        oc
          .columns(["tenant_id", "phone_number"])
          .doUpdateSet({ sent_at: now, message_id: messageId })
          .where(
            "marketing_sends.sent_at",
            "<=",
            marketingCapCutoff(now, marketingDays),
          ),
      ),
    insertIfClaimed(
      "conversations",
      conversationRow(ref),
      ref,
      messageId,
    ).onConflict((oc) => oc.doNothing()),
    insertIfClaimed("messages", message, ref, messageId),
    insertIfClaimed("outbox", outbox, ref, messageId),
    ...marked(true),
  ]);
  return (results[3]?.meta.changes ?? 0) === 0 ? "capped" : messageId;
}

/** The phone's `marketing_sends` row, when `messageId` holds the claim. */
function claim(ref: ConversationRef, messageId: string) {
  return db
    .selectFrom("marketing_sends")
    .where("tenant_id", "=", ref.tenantId)
    .where("phone_number", "=", ref.phoneNumber)
    .where("message_id", "=", messageId);
}

/** Inserts `row` into `table` only when `messageId` holds the phone's claim. */
function insertIfClaimed<T extends "conversations" | "messages" | "outbox">(
  table: T,
  row: Record<string, unknown>,
  ref: ConversationRef,
  messageId: string,
) {
  const columns = Object.keys(row);
  return db
    .insertInto(table)
    .columns(columns as never)
    .expression(
      claim(ref, messageId).select(
        columns.map((c) => sql.val(row[c]).as(c)),
      ) as never,
    );
}
