import type { DomainEvent } from "@vendeya/types";
import { clearUnreadAlert } from "../../conversation/unread-alerts.ts";
import { notificationRules } from "./config.ts";
import { dispatchNotifications } from "./dispatcher.ts";
import { evaluateNotifications } from "./evaluator.ts";

/**
 * Sends an event's notifications. Conversation alerts reserve an unread row
 * before emission. If delivery fails for every target, the row is released.
 */
export async function notify(event: DomainEvent): Promise<void> {
  let delivered = false;
  try {
    delivered = await dispatchNotifications(
      evaluateNotifications(event, notificationRules),
      event,
    );
  } finally {
    if (!delivered) await releaseUndeliveredAlert(event);
  }
}

async function releaseUndeliveredAlert(event: DomainEvent): Promise<void> {
  if (
    event.type !== "escalation_triggered" &&
    event.type !== "customer_message_received"
  ) {
    return;
  }
  if (!event.tenantId || !event.channelAccountId) return;

  await clearUnreadAlert({
    tenantId: event.tenantId,
    channelAccountId: event.channelAccountId,
    phoneNumber: event.payload.phoneNumber,
  });
}
