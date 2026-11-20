import { eventBus } from "../shared/events/index.ts";
import { AsyncEventEmitter } from "../shared/events/async-emitter.ts";
import type { DomainEvent } from "@vendeya/types";
import { createTraceId } from "@vendeya/utils";
import { notify } from "../domains/notifications/notify.ts";
import { CustomerService } from "../domains/customers/index.ts";
import { OrderWrites } from "../domains/orders/index.ts";
import { createLogger } from "../lib/logger.ts";

const logger = createLogger("event-bus");

function subscribe<E extends DomainEvent>(
  eventType: string,
  handler: (event: E) => void | Promise<void>,
): void {
  eventBus.on<E>(eventType, handler);
}

export const asyncEmitter = new AsyncEventEmitter(eventBus);

type PurchaseConfirmed = DomainEvent & { type: "purchase_confirmed" };

/**
 * Files the order a customer confirmed in a conversation, and alerts the
 * agents. The bundle is not a stocked variant, so it is a free line priced in
 * soles by the assistant. Only assistant orders alert: staff who take an order
 * already know about it.
 */
async function fileAssistantOrder(
  event: PurchaseConfirmed,
  tenantId: string,
  channelAccountId: string,
): Promise<void> {
  const { payload } = event;
  const customer = await CustomerService.upsertByPhone(tenantId, {
    phone: payload.phoneNumber,
    name: payload.clientName,
    document: payload.dni ? { type: "dni", number: payload.dni } : null,
  });
  const order = await OrderWrites.create({
    tenantId,
    customer,
    channelAccountId,
    source: "assistant",
    createdBy: null,
    lines: [
      {
        name: payload.productName,
        sku: payload.productId,
        quantity: 1,
        unitPriceCents: Math.round(payload.amount * 100),
      },
    ],
  });

  await eventBus.emit({
    type: "order_created",
    traceId: createTraceId(),
    timestamp: Date.now(),
    tenantId,
    channelAccountId,
    payload: {
      orderId: order.id,
      orderNumber: String(order.number),
      amountCents: order.total_cents,
      clientName: customer.name,
      phoneNumber: payload.phoneNumber,
      dni: payload.dni,
      productName: payload.productName,
    },
  });
}

export function setupEventSubscribers(): void {
  const notificationEvents: DomainEvent["type"][] = [
    "agent_assigned",
    "enrichment_limit_exceeded",
    "order_created",
    "escalation_triggered",
    "customer_message_received",
    "system_error_occurred",
    "attention_required",
    "system_outage_detected",
    "provider_degraded",
  ];

  subscribe("purchase_confirmed", async (event: PurchaseConfirmed) => {
    if (!event.tenantId || !event.channelAccountId) {
      // Without the tenant and channel account of the conversation there is
      // nowhere to file the order. Dropping it is safer than guessing.
      logger.error(
        { traceId: event.traceId, phoneNumber: event.payload.phoneNumber },
        "purchase_confirmed carried no tenant; order not created",
      );
      return;
    }
    await fileAssistantOrder(event, event.tenantId, event.channelAccountId);
  });

  notificationEvents.forEach((eventType) => {
    subscribe(eventType, notify);
  });
}
