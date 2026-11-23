import { env } from "cloudflare:workers";
import { createLogger } from "../../lib/logger.ts";
import { TenantSettings } from "../settings/system.ts";
import type { DomainEvent } from "@vendeya/types";
import { db } from "../../db/index.ts";

const logger = createLogger("notification-resolver");

/**
 * VendeYa's own operations group, for system alerts a tenant has not routed
 * elsewhere. Sales alerts have no platform fallback: they belong to the
 * business, so a business with no sales group gets them only through its
 * assigned agent.
 */
const STATIC_ROLES = {
  dev: () => env.WHATSAPP_GROUP_DEV,
} as Record<string, () => string | undefined>;

// A tenant routes its own alerts with these keys in its tenant settings.
const TENANT_ROLE_KEYS: Record<string, string> = {
  dev: "whatsapp_group_dev",
  sales: "whatsapp_group_sales",
};

async function staticTarget(
  target: string,
  tenantId?: string,
): Promise<string | undefined> {
  if (tenantId && TENANT_ROLE_KEYS[target]) {
    const configured = await TenantSettings.get(
      tenantId,
      TENANT_ROLE_KEYS[target]!,
    );
    if (configured) return configured;
  }
  return STATIC_ROLES[target]?.() || undefined;
}

export const NotificationResolver = {
  async resolve(
    target: string,
    event: DomainEvent,
  ): Promise<string | undefined> {
    // If it looks like a phone number, return it directly.
    if (/^\+?\d+$/.test(target) || target.includes("@g.us")) {
      return target;
    }

    if (target in STATIC_ROLES || target in TENANT_ROLE_KEYS) {
      const number = await staticTarget(target, event.tenantId);
      if (!number) {
        logger.warn(
          { role: target, tenantId: event.tenantId },
          "Role configured but no number found for tenant or environment",
        );
      }
      return number;
    }

    if (target === "agent") {
      const assigned = await resolveAssignedAgent(event);
      return assigned || (await staticTarget("sales", event.tenantId));
    }

    if (target === "assigned_agent") {
      return await resolveAssignedAgent(event);
    }

    logger.warn(
      { target, eventType: event.type },
      "Unknown notification target",
    );
    return undefined;
  },
};

/** The agent assigned to the conversation the event came from. */
async function resolveAssignedAgent(
  event: DomainEvent,
): Promise<string | undefined> {
  if (
    "phoneNumber" in event.payload &&
    typeof event.payload.phoneNumber === "string"
  ) {
    const customerPhone = event.payload.phoneNumber;

    // The conversation is named by tenant, channel account and contact number.
    // Without the channel account, the contact's thread on the tenant's other
    // number could match, and the wrong agent would be told. An event that
    // does not name the conversation gets no agent, and the caller falls back
    // to the sales group.
    if (!event.tenantId || !event.channelAccountId) {
      logger.warn(
        {
          eventType: event.type,
          tenantId: event.tenantId,
          channelAccountId: event.channelAccountId,
        },
        "Cannot resolve agent: event does not name the conversation",
      );
      return undefined;
    }

    const result = await db
      .selectFrom("conversations as c")
      .innerJoin("users as u", "c.assigned_agent", "u.id")
      .select("u.phone_number")
      .where("c.tenant_id", "=", event.tenantId)
      .where("c.channel_account_id", "=", event.channelAccountId)
      .where("c.phone_number", "=", customerPhone)
      .executeTakeFirst();

    return result?.phone_number ?? undefined;
  }

  logger.warn(
    { eventType: event.type },
    "Cannot resolve agent: Event payload missing phoneNumber",
  );
  return undefined;
}
