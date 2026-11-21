import { eventBus } from "../shared/events/index.ts";
import { AsyncEventEmitter } from "../shared/events/async-emitter.ts";
import type { DomainEvent } from "@vendeya/types";
import { notify } from "../domains/notifications/notify.ts";

function subscribe<E extends DomainEvent>(
  eventType: string,
  handler: (event: E) => void | Promise<void>,
): void {
  eventBus.on<E>(eventType, handler);
}

export const asyncEmitter = new AsyncEventEmitter(eventBus);

export function setupEventSubscribers(): void {
  const notificationEvents: DomainEvent["type"][] = [
    "agent_assigned",
    "order_created",
    "escalation_triggered",
    "customer_message_received",
    "system_error_occurred",
    "system_outage_detected",
    "provider_degraded",
  ];

  notificationEvents.forEach((eventType) => {
    subscribe(eventType, notify);
  });
}
