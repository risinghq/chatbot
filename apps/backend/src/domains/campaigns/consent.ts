import { db, tenantScope } from "../../db/index.ts";

/**
 * The words that opt a customer out of marketing, per Meta's own convention
 * for WhatsApp subscriptions. Compared on the normalized text, so "STOP" and
 * "No mas mensajes!" count, and "no baja el precio" does not.
 */
const OPT_OUT_PHRASES = new Set([
  "baja",
  "stop",
  "no mas mensajes",
  "dame de baja",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether `content` is an opt-out request. */
export function isOptOutMessage(content: string): boolean {
  return OPT_OUT_PHRASES.has(normalize(content));
}

export async function isOptedOut(
  tenantId: string,
  phoneNumber: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("marketing_opt_outs")
    .select("phone_number")
    .where(tenantScope(tenantId))
    .where("phone_number", "=", phoneNumber)
    .executeTakeFirst();
  return row !== undefined;
}

/** Records or clears a phone's marketing opt-out. `source` says who asked. */
export async function setOptOut(
  tenantId: string,
  phoneNumber: string,
  optedOut: boolean,
  source: "message" | "staff",
): Promise<void> {
  if (!optedOut) {
    await db
      .deleteFrom("marketing_opt_outs")
      .where(tenantScope(tenantId))
      .where("phone_number", "=", phoneNumber)
      .execute();
    return;
  }
  await db
    .insertInto("marketing_opt_outs")
    .values({
      tenant_id: tenantId,
      phone_number: phoneNumber,
      source,
      created_at: Date.now(),
    })
    .onConflict((oc) => oc.columns(["tenant_id", "phone_number"]).doNothing())
    .execute();
}
