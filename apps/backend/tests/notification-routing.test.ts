import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createTenantFixture, type TenantFixture } from "./helpers/tenancy.ts";

import { getOne, run } from "../src/db/index.ts";
import { notificationRules } from "../src/domains/notifications/config.ts";
import { evaluateNotifications } from "../src/domains/notifications/evaluator.ts";
import {
  accountForEvent,
  dispatchNotifications,
} from "../src/domains/notifications/dispatcher.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { SystemSettings } from "../src/domains/settings/system.ts";
import type { DomainEvent } from "@vendeya/types";

const CUSTOMER = "51987654321";
const CHANNEL = "ch-notifications-fixture";

function contentFor(event: DomainEvent): string {
  const decisions = evaluateNotifications(event, notificationRules);
  const sent = decisions.find((decision) => decision.status === "sent");

  if (sent?.status !== "sent") {
    throw new Error(`No notification was produced for ${event.type}`);
  }

  return sent.content;
}

/**
 * A conversation is identified by (tenant, channel account, phone number). With
 * the phone number alone, a tenant with a second WhatsApp number gets 409
 * "ambiguous" from the dashboard.
 */
describe("the link an alert carries", () => {
  const base = {
    traceId: "trace-1",
    timestamp: Date.now(),
    tenantId: "tn-notifications",
    channelAccountId: CHANNEL,
  };

  const expectedLink = `/dashboard/conversations/${CUSTOMER}?channel=${CHANNEL}`;

  it("names the thread on an assignment", async () => {
    expect(
      contentFor({
        ...base,
        type: "agent_assigned",
        payload: {
          phoneNumber: CUSTOMER,
          agentId: "u-1",
          agentPhone: "51900000001",
          clientName: "Ana",
          dni: "12345678",
        },
      }),
    ).toContain(expectedLink);
  });

  it("names the thread on an escalation", async () => {
    expect(
      contentFor({
        ...base,
        type: "escalation_triggered",
        payload: { phoneNumber: CUSTOMER, reason: "multiple_objections" },
      }),
    ).toContain(expectedLink);
  });

  it("names the thread when attention is required", async () => {
    expect(
      contentFor({
        ...base,
        type: "attention_required",
        payload: {
          phoneNumber: CUSTOMER,
          clientName: "Ana",
          dni: "12345678",
          reason: "manual_review",
        },
      }),
    ).toContain(expectedLink);
  });

  it("names the thread on a contract upload", async () => {
    expect(
      contentFor({
        ...base,
        type: "contract_uploaded",
        payload: {
          phoneNumber: CUSTOMER,
          clientName: "Ana",
          contractPath: "/api/assets/a-1",
        },
      }),
    ).toContain(expectedLink);
  });

  it("names the thread on an enrichment loop alert", async () => {
    expect(
      contentFor({
        ...base,
        type: "enrichment_limit_exceeded",
        payload: { phoneNumber: CUSTOMER, lastPhase: "offering_products" },
      }),
    ).toContain(expectedLink);
  });

  it("still links an order to the order, not the conversation", async () => {
    const content = contentFor({
      ...base,
      type: "order_created",
      payload: {
        orderId: "ord-1",
        orderNumber: "1001",
        amountCents: 179900,
        clientName: "Ana",
        phoneNumber: CUSTOMER,
        dni: "12345678",
        productName: "Combo",
      },
    } as DomainEvent);

    expect(content).toContain("/dashboard/orders/ord-1");
  });
});

/**
 * The dispatcher must use `sendDirect`'s result. The Cloud adapter refuses a
 * pending or disabled number, and that alert must be recorded as failed.
 */
describe("dispatching an alert on a number that cannot send", () => {
  let tenant: TenantFixture;
  let pendingAccountId: string;

  beforeEach(async () => {
    tenant = await createTenantFixture("notifications");

    // A number registered but not yet able to send. The Cloud adapter refuses
    // it.
    pendingAccountId = (
      await ChannelAccountService.create({
        tenantId: tenant.tenantId,
        phoneNumberId: `pnid-${crypto.randomUUID().slice(0, 8)}`,
        label: "Pendiente",
      })
    ).id;
  });

  async function trace(
    traceId: string,
  ): Promise<{ status: string; reason: string | null }> {
    return (await getOne(
      "SELECT status, reason FROM notification_traces WHERE trace_id = ?",
      [traceId],
    )) as { status: string; reason: string | null };
  }

  it("records it as failed, not sent", async () => {
    const traceId = `trace-${crypto.randomUUID()}`;

    await dispatchNotifications(
      [
        {
          status: "sent",
          content: "Ana espera atención.",
          target: "51900000001",
          ruleId: "agent_assignment_whatsapp",
          channel: "whatsapp",
        },
      ],
      {
        type: "agent_assigned",
        traceId,
        timestamp: Date.now(),
        tenantId: tenant.tenantId,
        channelAccountId: pendingAccountId,
        payload: {
          phoneNumber: CUSTOMER,
          agentId: "u-1",
          agentPhone: "51900000001",
          clientName: "Ana",
        },
      },
    );

    expect(await trace(traceId)).toEqual({
      status: "failed",
      reason: "send_failed",
    });
  });
});

/**
 * `notification_traces.tenant_id` is nullable because some events belong to the
 * platform, such as both eligibility providers being down. GET /api/providers/:dni
 * raises it with no tenant or channel account. Requiring a tenant account would
 * record `no_channel_account` and deliver nothing.
 */
describe("a platform-wide alert with no tenant", () => {
  /** What the rule's "dev" target resolves to: VendeYa's own operations group. */
  const DEV_GROUP = "51900000999@g.us";

  let tenant: TenantFixture;
  let opsAccountId: string;
  let opsPhoneNumberId: string;
  let sends: Array<{ url: string; to: string; body: string }>;

  const originalFetch = globalThis.fetch;

  /** The event GET /api/providers/:dni raises: no tenant, no channel account. */
  function outageEvent(traceId: string): DomainEvent {
    return {
      type: "system_outage_detected",
      traceId,
      timestamp: Date.now(),
      payload: { dni: "12345678", errors: ["fnb 503", "powerbi 503"] },
    } as DomainEvent;
  }

  function outageDecisions(): Parameters<typeof dispatchNotifications>[0] {
    return [
      {
        status: "sent",
        content: "Ambos proveedores caídos.",
        target: DEV_GROUP,
        ruleId: "system_outage_alert",
        channel: "whatsapp",
      },
    ];
  }

  async function trace(traceId: string): Promise<{
    status: string;
    reason: string | null;
    tenant_id: string | null;
  }> {
    return (await getOne(
      "SELECT status, reason, tenant_id FROM notification_traces WHERE trace_id = ?",
      [traceId],
    )) as {
      status: string;
      reason: string | null;
      tenant_id: string | null;
    };
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("platform-ops");

    // VendeYa's own number: a real account that can send, which the platform
    // owns rather than borrowing from whichever tenant is at hand.
    const account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: `pnid-ops-${crypto.randomUUID().slice(0, 8)}`,
      label: "VendeYa Ops",
      accessToken: "ops-token",
    });
    opsAccountId = account.id;
    opsPhoneNumberId = account.phone_number_id;

    sends = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = input.toString();
      const body = init?.body ? JSON.parse(init.body) : {};
      sends.push({ url, to: body.to, body: body.text?.body ?? "" });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.ops" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    env.PLATFORM_OPS_PHONE_NUMBER_ID = "";
    await run("DELETE FROM system_settings WHERE key = ?", [
      "platform_ops_channel_account_id",
    ]);
    await run("DELETE FROM notification_traces WHERE tenant_id IS NULL");
  });

  // The operations account resolves from the `platform_ops_channel_account_id`
  // setting, else PLATFORM_OPS_PHONE_NUMBER_ID.
  it("goes out on the designated platform operations account", async () => {
    await SystemSettings.set("platform_ops_channel_account_id", opsAccountId);

    const traceId = `trace-${crypto.randomUUID()}`;
    await dispatchNotifications(outageDecisions(), outageEvent(traceId));

    expect(await trace(traceId)).toEqual({
      status: "sent",
      reason: null,
      tenant_id: null,
    });

    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain(`/${opsPhoneNumberId}/messages`);
    expect(sends[0]!.to).toBe(DEV_GROUP);
    expect(sends[0]!.body).toBe("Ambos proveedores caídos.");
  });

  it("falls back to PLATFORM_OPS_PHONE_NUMBER_ID with no designation", async () => {
    env.PLATFORM_OPS_PHONE_NUMBER_ID = opsPhoneNumberId;

    const traceId = `trace-${crypto.randomUUID()}`;
    await dispatchNotifications(outageDecisions(), outageEvent(traceId));

    expect((await trace(traceId)).status).toBe("sent");
    expect(sends[0]!.url).toContain(`/${opsPhoneNumberId}/messages`);
  });

  it("prefers the designated account over the environment", async () => {
    const other = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: `pnid-env-${crypto.randomUUID().slice(0, 8)}`,
      label: "Otro",
      accessToken: "other-token",
    });
    env.PLATFORM_OPS_PHONE_NUMBER_ID = other.phone_number_id;

    await SystemSettings.set("platform_ops_channel_account_id", opsAccountId);

    const traceId = `trace-${crypto.randomUUID()}`;
    await dispatchNotifications(outageDecisions(), outageEvent(traceId));

    expect(sends[0]!.url).toContain(`/${opsPhoneNumberId}/messages`);
  });

  it("records why nothing went out when the platform names no account", async () => {
    const traceId = `trace-${crypto.randomUUID()}`;
    await dispatchNotifications(outageDecisions(), outageEvent(traceId));

    expect(await trace(traceId)).toEqual({
      status: "failed",
      reason: "no_channel_account",
      tenant_id: null,
    });
    expect(sends).toHaveLength(0);
  });

  it("still prefers the tenant's own account when the event names one", async () => {
    await SystemSettings.set("platform_ops_channel_account_id", opsAccountId);

    expect(
      (
        await accountForEvent({
          type: "system_error_occurred",
          traceId: "trace-scoped",
          timestamp: Date.now(),
          tenantId: tenant.tenantId,
          channelAccountId: tenant.channelAccountId,
          payload: { phoneNumber: CUSTOMER, error: "boom" },
        } as DomainEvent)
      )?.id,
    ).toBe(tenant.channelAccountId);
  });

  describe("and a tenant's alert when that tenant has no number", () => {
    let bare: TenantFixture;

    function tenantEvent(traceId: string, channelAccountId?: string) {
      return {
        type: "system_error_occurred",
        traceId,
        timestamp: Date.now(),
        tenantId: bare.tenantId,
        channelAccountId,
        payload: { phoneNumber: CUSTOMER, error: "boom" },
      } as DomainEvent;
    }

    beforeEach(async () => {
      bare = await createTenantFixture("no-number");
      await run("DELETE FROM channel_accounts WHERE tenant_id = ?", [
        bare.tenantId,
      ]);
      await SystemSettings.set("platform_ops_channel_account_id", opsAccountId);
    });

    it("is recorded as failed and sends nothing", async () => {
      const traceId = `trace-${crypto.randomUUID()}`;
      await dispatchNotifications(outageDecisions(), tenantEvent(traceId));

      expect(await trace(traceId)).toEqual({
        status: "failed",
        reason: "no_channel_account",
        tenant_id: bare.tenantId,
      });
      expect(sends).toHaveLength(0);
    });

    it("is not rescued by a stale channel account id on the event", async () => {
      const traceId = `trace-${crypto.randomUUID()}`;
      await dispatchNotifications(
        outageDecisions(),
        tenantEvent(traceId, "ch-deleted"),
      );

      expect((await trace(traceId)).reason).toBe("no_channel_account");
      expect(sends).toHaveLength(0);
    });

    it("goes out on the tenant's default number once it has one", async () => {
      const own = await ChannelAccountService.create({
        tenantId: bare.tenantId,
        phoneNumberId: `pnid-own-${crypto.randomUUID().slice(0, 8)}`,
        label: "Propio",
        accessToken: "own-token",
      });

      const traceId = `trace-${crypto.randomUUID()}`;
      await dispatchNotifications(
        outageDecisions(),
        tenantEvent(traceId, "ch-deleted"),
      );

      expect((await trace(traceId)).status).toBe("sent");
      expect(sends).toHaveLength(1);
      expect(sends[0]!.url).toContain(`/${own.phone_number_id}/messages`);
      expect(sends[0]!.url).not.toContain(`/${opsPhoneNumberId}/messages`);
    });
  });
});
