export type BaseEvent = {
  traceId: string;
  timestamp: number;
  /**
   * Tenant the event belongs to. Optional only because a few platform-level
   * events (a shared provider going down) are not attributable to one tenant;
   * everything raised from a conversation carries it.
   */
  tenantId?: string;
  /** Channel account the event originated on, when there is one. */
  channelAccountId?: string;
};

export type DomainEvent =
  | (BaseEvent & {
      type: "agent_assigned";
      payload: {
        phoneNumber: string;
        agentId: string;
        agentPhone: string | null;
        clientName: string | null;
      };
    })
  | (BaseEvent & {
      type: "order_created";
      payload: {
        orderId: string;
        orderNumber: string;
        amountCents: number;
        clientName: string;
        phoneNumber: string;
        dni?: string;
        productName?: string;
      };
    })
  | (BaseEvent & {
      type: "system_outage_detected";
      payload: {
        dni: string;
        errors: string[];
        timestamp: number;
      };
    })
  | (BaseEvent & {
      type: "provider_degraded";
      payload: {
        failedProvider: string;
        workingProvider: string;
        dni: string;
        errors: string[];
      };
    })
  | (BaseEvent & {
      type: "escalation_triggered";
      payload: {
        reason: string;
        phoneNumber: string;
        context?: Record<string, unknown>;
      };
    })
  | (BaseEvent & {
      type: "customer_message_received";
      payload: {
        phoneNumber: string;
        clientName?: string;
      };
    })
  | (BaseEvent & {
      type: "system_error_occurred";
      payload: {
        phoneNumber: string;
        error: string;
        context?: Record<string, unknown>;
      };
    });
