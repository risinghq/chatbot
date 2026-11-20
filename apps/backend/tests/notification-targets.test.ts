/**
 * Where a rule's named target sends. Sales alerts carry a customer's name,
 * phone and DNI and belong to the business, so they never fall back to a
 * platform group. Only system alerts ("dev") fall back to VendeYa's own.
 */

import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DomainEvent } from "@vendeya/types";

import { createTenantFixture, type TenantFixture } from "./helpers/tenancy.ts";
import { NotificationResolver } from "../src/domains/notifications/resolver.ts";
import { TenantSettings } from "../src/domains/settings/system.ts";

const PLATFORM_DEV_GROUP = "120363000000000999@g.us";
const SALES_GROUP = "120363000000000001@g.us";

describe("notification targets", () => {
  let tenant: TenantFixture;
  const originalDevGroup = env.WHATSAPP_GROUP_DEV;

  beforeEach(async () => {
    tenant = await createTenantFixture("targets");
    env.WHATSAPP_GROUP_DEV = PLATFORM_DEV_GROUP;
  });

  afterEach(() => {
    env.WHATSAPP_GROUP_DEV = originalDevGroup;
  });

  function event(): DomainEvent {
    return {
      type: "escalation_triggered",
      traceId: `trace-${crypto.randomUUID()}`,
      timestamp: Date.now(),
      tenantId: tenant.tenantId,
      channelAccountId: tenant.channelAccountId,
      payload: { phoneNumber: "51911111111", reason: "multiple_objections" },
    } as DomainEvent;
  }

  it("sends a sales alert to the business's own sales group", async () => {
    await TenantSettings.set(
      tenant.tenantId,
      "whatsapp_group_sales",
      SALES_GROUP,
    );

    expect(await NotificationResolver.resolve("sales", event())).toBe(
      SALES_GROUP,
    );
    expect(await NotificationResolver.resolve("agent", event())).toBe(
      SALES_GROUP,
    );
  });

  it("sends a sales alert nowhere when the business has no sales group", async () => {
    expect(
      await NotificationResolver.resolve("sales", event()),
    ).toBeUndefined();
    expect(
      await NotificationResolver.resolve("agent", event()),
    ).toBeUndefined();
  });

  it("sends a system alert to the platform group when the business has none", async () => {
    expect(await NotificationResolver.resolve("dev", event())).toBe(
      PLATFORM_DEV_GROUP,
    );
  });
});
