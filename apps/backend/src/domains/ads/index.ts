import type { AdReferral, ConversationRef } from "@vendeya/types";
import { db } from "../../db/index.ts";
import { byRef } from "../../conversation/store.ts";

/** How long after the click an order still counts as the ad's sale. */
export const AD_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The ad the conversation's contact last arrived through, kept as the row's
 * latest: a later click replaces it, a plain message leaves it. `at` is the
 * message's WhatsApp timestamp, not the delivery's, so a redelivery keeps the
 * click's own time.
 */
export async function recordAd(
  ref: ConversationRef,
  ad: AdReferral,
  at: number,
): Promise<void> {
  await byRef(
    db.updateTable("conversations").set({
      ad_source_id: ad.sourceId,
      ad_headline: ad.headline,
      ad_ctwa_clid: ad.ctwaClid,
      ad_received_at: at,
    }),
    ref,
  )
    // Only a newer click becomes the latest ad: Meta can deliver an older
    // referral after a newer one, and a stale write would send the next
    // order's credit to a click the customer already moved past.
    .where((eb) =>
      eb.or([eb("ad_received_at", "is", null), eb("ad_received_at", "<", at)]),
    )
    .execute();
}

/**
 * The ad an order on this conversation records, or null when the contact has
 * none or the click is already outside the window.
 */
export async function adForOrder(
  ref: ConversationRef,
  now: number,
): Promise<{ ad_source_id: string; ad_headline: string | null } | null> {
  const row = await byRef(
    db
      .selectFrom("conversations")
      .select(["ad_source_id", "ad_headline", "ad_received_at"]),
    ref,
  ).executeTakeFirst();

  if (!row?.ad_source_id || !row.ad_received_at) return null;
  if (now - row.ad_received_at > AD_ATTRIBUTION_WINDOW_MS) return null;
  return { ad_source_id: row.ad_source_id, ad_headline: row.ad_headline };
}
