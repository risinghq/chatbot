import type { DomainEvent } from "@vendeya/types";
import { templates } from "./templates.ts";

export type NotificationRule = {
  id: string;
  triggerEvent: DomainEvent["type"];
  channel: "whatsapp" | "push";
  target: string | ((event: DomainEvent) => string | undefined);
  condition: (event: DomainEvent) => boolean;
  template: (event: DomainEvent) => string;
};

export const notificationRules: NotificationRule[] = [
  {
    id: "agent_assignment_whatsapp",
    triggerEvent: "agent_assigned",
    channel: "whatsapp",
    target: (event) => {
      if (event.type !== "agent_assigned") return undefined;
      return event.payload.agentPhone || undefined;
    },
    condition: (event) => {
      if (event.type !== "agent_assigned") return false;
      return !!event.payload.agentPhone;
    },
    template: (event) => {
      if (event.type !== "agent_assigned") return "";
      return templates.assignment({
        tenantId: event.tenantId,
        phoneNumber: event.payload.phoneNumber,
        channelAccountId: event.channelAccountId,
        clientName: event.payload.clientName,
      });
    },
  },
  {
    id: "new_order_alert",
    triggerEvent: "order_created",
    channel: "whatsapp",
    target: "agent",
    condition: (event) => event.type === "order_created",
    template: (event) => {
      if (event.type !== "order_created") return "";
      return templates.newOrder(
        {
          tenantId: event.tenantId,
          phoneNumber: event.payload.phoneNumber,
          clientName: event.payload.clientName || "Cliente",
          dni: event.payload.dni,
          urlSuffix: `/orders/${event.payload.orderId}`,
        },
        event.payload.orderNumber,
        event.payload.amountCents,
        event.payload.productName,
      );
    },
  },
  {
    id: "escalation_alert",
    triggerEvent: "escalation_triggered",
    channel: "whatsapp",
    target: "agent",
    condition: (event) => event.type === "escalation_triggered",
    template: (event) => {
      if (event.type !== "escalation_triggered") return "";
      let reason = event.payload.reason;

      const map: Record<string, string> = {
        customer_question_during_objection:
          "Pregunta durante manejo de objeción",
        multiple_objections: "Cliente rechazó múltiples ofertas",
        customer_question_requires_human:
          "Pregunta del cliente requiere atención humana",
        reply_undeliverable: "No se pudo entregar una respuesta al cliente",
        turn_failed: "El bot no pudo responder al cliente",
      };

      if (map[reason]) {
        reason = map[reason]!;
      }

      return templates.escalation(
        {
          tenantId: event.tenantId,
          phoneNumber: event.payload.phoneNumber,
          channelAccountId: event.channelAccountId,
        },
        reason,
      );
    },
  },
  {
    id: "customer_message_alert",
    triggerEvent: "customer_message_received",
    channel: "whatsapp",
    target: "assigned_agent",
    condition: (event) => event.type === "customer_message_received",
    template: (event) => {
      if (event.type !== "customer_message_received") return "";
      return templates.customerMessage({
        tenantId: event.tenantId,
        phoneNumber: event.payload.phoneNumber,
        channelAccountId: event.channelAccountId,
        clientName: event.payload.clientName,
      });
    },
  },
  {
    id: "system_error_alert",
    triggerEvent: "system_error_occurred",
    channel: "whatsapp",
    target: "dev",
    condition: (event) => event.type === "system_error_occurred",
    template: (event) => {
      if (event.type !== "system_error_occurred") return "";
      return templates.systemError(
        {
          tenantId: event.tenantId,
          phoneNumber: event.payload.phoneNumber,
          channelAccountId: event.channelAccountId,
        },
        event.payload.error,
      );
    },
  },
  {
    id: "system_outage_alert",
    triggerEvent: "system_outage_detected",
    channel: "whatsapp",
    target: "dev",
    condition: (event) => event.type === "system_outage_detected",
    template: (event) => {
      if (event.type !== "system_outage_detected") return "";
      return templates.systemOutage(
        { phoneNumber: "N/A", dni: event.payload.dni },
        event.payload.errors,
      );
    },
  },
  {
    id: "provider_degraded_alert",
    triggerEvent: "provider_degraded",
    channel: "whatsapp",
    target: "dev",
    condition: () => true,
    template: (event) => {
      if (event.type !== "provider_degraded") return "";
      return templates.degradation(
        { phoneNumber: "N/A", dni: event.payload.dni },
        event.payload.failedProvider,
        event.payload.workingProvider,
      );
    },
  },
  // Push mirrors the business events above with short bodies and no WhatsApp
  // markup: the notification shows the text and opens the page it is about.
  {
    id: "agent_assignment_push",
    triggerEvent: "agent_assigned",
    channel: "push",
    target: (event) =>
      event.type === "agent_assigned" ? event.payload.agentId : undefined,
    condition: (event) => event.type === "agent_assigned",
    template: (event) => {
      if (event.type !== "agent_assigned") return "";
      return templates.pushAssignment(
        event.payload.clientName || event.payload.phoneNumber,
      );
    },
  },
  {
    id: "new_order_push",
    triggerEvent: "order_created",
    channel: "push",
    target: "agent",
    condition: (event) => event.type === "order_created",
    template: (event) => {
      if (event.type !== "order_created") return "";
      return templates.pushNewOrder(
        event.payload.clientName || "Cliente",
        event.payload.orderNumber,
        event.payload.amountCents,
      );
    },
  },
  {
    id: "escalation_push",
    triggerEvent: "escalation_triggered",
    channel: "push",
    target: "agent",
    condition: (event) => event.type === "escalation_triggered",
    template: (event) => {
      if (event.type !== "escalation_triggered") return "";
      return templates.pushEscalation(event.payload.phoneNumber);
    },
  },
  {
    id: "customer_message_push",
    triggerEvent: "customer_message_received",
    channel: "push",
    target: "assigned_agent",
    condition: (event) => event.type === "customer_message_received",
    template: (event) => {
      if (event.type !== "customer_message_received") return "";
      return templates.pushCustomerMessage(
        event.payload.clientName || event.payload.phoneNumber,
      );
    },
  },
];
