import { newId } from "@vendeya/utils";
import type { DomainEvent } from "@vendeya/types";
import { db, tenantScope } from "../../db/index.ts";
import { sendPushNotification } from "../../adapters/push/index.ts";
import { publicOrigin } from "../../config.ts";

/** Upserts the user's subscription in the business, keyed by its endpoint. */
export async function savePushSubscription(
  tenantId: string,
  userId: string,
  subscription: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  await db
    .insertInto("push_subscriptions")
    .values({
      id: newId(),
      tenant_id: tenantId,
      user_id: userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "endpoint"]).doUpdateSet({
        user_id: userId,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      }),
    )
    .execute();
}

/** Removes the user's own subscription in the business. */
export async function deletePushSubscription(
  tenantId: string,
  userId: string,
  endpoint: string,
): Promise<void> {
  await db
    .deleteFrom("push_subscriptions")
    .where("endpoint", "=", endpoint)
    .where("user_id", "=", userId)
    .where(tenantScope(tenantId))
    .execute();
}

/**
 * The users a push target names. "agent" and "assigned_agent" resolve through
 * the conversation's assigned agent, as the WhatsApp resolver does; where the
 * WhatsApp target falls back to the sales group, "agent" here falls back to
 * every member who opted in. Any other target is a user id already.
 */
async function userIdsForTarget(
  target: string,
  event: DomainEvent,
  tenantId: string,
): Promise<string[]> {
  const phoneNumber =
    "phoneNumber" in event.payload ? event.payload.phoneNumber : "";
  if (target === "agent" || target === "assigned_agent") {
    const conversation = await db
      .selectFrom("conversations")
      .select("assigned_agent")
      .where("tenant_id", "=", tenantId)
      .where("channel_account_id", "=", event.channelAccountId ?? "")
      .where("phone_number", "=", phoneNumber)
      .executeTakeFirst();

    if (conversation?.assigned_agent) return [conversation.assigned_agent];
    if (target === "assigned_agent" || !event.tenantId) return [];

    const members = await db
      .selectFrom("push_subscriptions")
      .select("user_id")
      .where("tenant_id", "=", tenantId)
      .groupBy("user_id")
      .execute();
    return members.map((m) => m.user_id);
  }

  return [target];
}

/** The dashboard page the notification opens on a click. */
function pushLink(event: DomainEvent): string | undefined {
  if (!event.tenantId) return undefined;
  const base = `${publicOrigin()}/dashboard/${event.tenantId}`;
  if (event.type === "order_created") {
    return `${base}/orders/${event.payload.orderId}`;
  }
  const phoneNumber =
    "phoneNumber" in event.payload ? event.payload.phoneNumber : "";
  const query = event.channelAccountId
    ? `?channel=${encodeURIComponent(event.channelAccountId)}`
    : "";
  return `${base}/conversations/${phoneNumber}${query}`;
}

/**
 * Delivers an event's push notification to every subscription of its target's
 * users in the business. A subscription the service reports gone is deleted.
 * Nobody subscribed is "no_recipient", not a failure.
 */
export async function sendEventPush(
  target: string,
  content: string,
  event: DomainEvent,
): Promise<"sent" | "no_recipient" | "failed"> {
  if (!event.tenantId) return "no_recipient";

  const userIds = await userIdsForTarget(target, event, event.tenantId);
  if (userIds.length === 0) return "no_recipient";

  const subscriptions = await db
    .selectFrom("push_subscriptions")
    .select(["id", "endpoint", "p256dh", "auth"])
    .where("tenant_id", "=", event.tenantId)
    .where("user_id", "in", userIds)
    .execute();

  if (subscriptions.length === 0) return "no_recipient";

  let delivered = false;
  for (const subscription of subscriptions) {
    const outcome = await sendPushNotification(subscription, {
      title: "VendeYa",
      body: content,
      url: pushLink(event),
    });
    if (outcome === "gone") {
      await db
        .deleteFrom("push_subscriptions")
        .where("id", "=", subscription.id)
        .where(tenantScope(event.tenantId))
        .execute();
    }
    if (outcome === "sent") delivered = true;
  }

  return delivered ? "sent" : "failed";
}
