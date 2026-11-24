import type { ConversationRef, ParamBinding } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { outboxInsert, queuedBehind } from "../../conversation/outbox.ts";
import { MessageStore } from "../../adapters/whatsapp/message-store.ts";
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
 * breaks consent: `"opted_out"` or `"capped"`. A marketing send claims the
 * phone's `marketing_sends` record atomically first, so concurrent senders
 * cannot both pass the cap.
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
  if (marketingDays !== null) {
    if (await isOptedOut(ref.tenantId, ref.phoneNumber)) return "opted_out";
    // The cap is claimed atomically: the conditional upsert writes this
    // send's stamp only when the phone is outside the window, so two
    // concurrent senders cannot both pass.
    const claimed = await db
      .insertInto("marketing_sends")
      .values({
        tenant_id: ref.tenantId,
        phone_number: ref.phoneNumber,
        sent_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(["tenant_id", "phone_number"])
          .doUpdateSet({ sent_at: now })
          .where("marketing_sends.sent_at", "<=", now - marketingDays * DAY_MS),
      )
      .executeTakeFirst();
    if (Number(claimed.numInsertedOrUpdatedRows ?? 0) === 0) return "capped";
  }
  const messageId = newId();
  try {
    await ensureConversation(ref);
    const parameters = resolveParams(bindings, ctx);
    const rendered = renderBody(template.body, parameters);
    await batch([
      MessageStore.logStatement(
        messageId,
        ref,
        "outbound",
        "template",
        rendered,
        "queued",
      ),
      outboxInsert({
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
      }),
    ]);
  } catch (error) {
    // The send rows did not commit, so the claim must not hold: only the
    // row this call stamped is removed.
    if (marketingDays !== null) {
      await db
        .deleteFrom("marketing_sends")
        .where("tenant_id", "=", ref.tenantId)
        .where("phone_number", "=", ref.phoneNumber)
        .where("sent_at", "=", now)
        .execute();
    }
    throw error;
  }
  return messageId;
}
