import type { ConversationRef, ParamBinding } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { sql } from "kysely";
import { outboxRow, queuedBehind } from "../../conversation/outbox.ts";
import { messageRow } from "../../adapters/whatsapp/message-store.ts";
import { ensureConversation } from "../../conversation/store.ts";
import { batch, db } from "../../db/index.ts";
import { isOptedOut } from "./consent.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * breaks consent: `"opted_out"` or `"capped"`.
 * The conversation is created when the contact has never written. The
 * conversation's object sends the row on its next wake, which the sweep's
 * outbox check schedules.
 */
export async function enqueueTemplate(
  ref: ConversationRef,
  template: { name: string; language: string; body: string },
  bindings: ParamBinding[],
  ctx: ParamContext,
  now: number,
  marketingDays: number | null,
): Promise<string | "opted_out" | "capped"> {
  if (
    marketingDays !== null &&
    (await isOptedOut(ref.tenantId, ref.phoneNumber))
  ) {
    return "opted_out";
  }
  await ensureConversation(ref);
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

  if (marketingDays === null) {
    await batch([
      db.insertInto("messages").values(message),
      db.insertInto("outbox").values(outbox),
    ]);
    return messageId;
  }

  // One batch is one transaction. The upsert stamps this send's id only when
  // the phone is outside the window, and the two inserts run only when the
  // stamp is this send's, so concurrent senders cannot both pass and a claim
  // never commits without its send rows.
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
          .where("marketing_sends.sent_at", "<=", now - marketingDays * DAY_MS),
      ),
    insertIfClaimed("messages", message, ref, messageId),
    insertIfClaimed("outbox", outbox, ref, messageId),
  ]);
  return (results[2]?.meta.changes ?? 0) === 0 ? "capped" : messageId;
}

/** Inserts `row` into `table` only when `messageId` holds the phone's claim. */
function insertIfClaimed<T extends "messages" | "outbox">(
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
      db
        .selectFrom("marketing_sends")
        .select(columns.map((c) => sql.val(row[c]).as(c)))
        .where("tenant_id", "=", ref.tenantId)
        .where("phone_number", "=", ref.phoneNumber)
        .where("message_id", "=", messageId) as never,
    );
}
