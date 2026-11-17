/**
 * A bot reply that `WhatsAppService` refuses before the adapter is called must
 * not vanish. Each test sends through `WhatsAppService.sendMessage` and runs the
 * cron sweep, which wakes each conversation owed a handoff. The only fake is
 * the network, and a refused send must never reach it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAll, getOne, run } from "../src/db/index.ts";
import {
  createTenantFixture,
  insertConversation,
  type TenantFixture,
  setChannelStatus,
} from "./helpers/tenancy.ts";

import type { ConversationRef, DomainEvent } from "@vendeya/types";

import {
  ChannelUnavailableError,
  WhatsAppService,
} from "../src/adapters/whatsapp/index.ts";
import type { OutboxRow } from "../src/conversation/outbox.ts";
import { logsDuring } from "./helpers/logs.ts";
import { sweepAt } from "./helpers/turn.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { eventBus } from "../src/shared/events/index.ts";

const CUSTOMER = "51900777001";

describe("a reply WhatsAppService refuses before it reaches the adapter", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let originalFetch: typeof globalThis.fetch;
  let requests: number;
  let alerts: DomainEvent[];

  const onAlert = (event: DomainEvent) => {
    if (event.tenantId === tenant.tenantId) alerts.push(event);
  };

  async function outboxOf(of: ConversationRef): Promise<OutboxRow[]> {
    return (await getAll(
      `SELECT * FROM outbox
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
         ORDER BY id`,
      [of.tenantId, of.channelAccountId, of.phoneNumber],
    )) as OutboxRow[];
  }

  async function outboundStatuses(of: ConversationRef): Promise<string[]> {
    return (
      (await getAll(
        `SELECT status FROM messages
           WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
             AND direction = 'outbound'
           ORDER BY created_at, ROWID`,
        [of.tenantId, of.channelAccountId, of.phoneNumber],
      )) as Array<{
        status: string;
      }>
    ).map((row) => row.status);
  }

  async function messageCount(): Promise<number> {
    return (
      (await getOne("SELECT COUNT(*) AS n FROM messages")) as { n: number }
    ).n;
  }

  async function conversationOf(of: ConversationRef) {
    return (await getOne(
      `SELECT status, handover_reason FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [of.tenantId, of.channelAccountId, of.phoneNumber],
    )) as {
      status: string;
      handover_reason: string | null;
    };
  }

  async function setTenantStatus(
    status: "active" | "suspended",
  ): Promise<void> {
    await run("UPDATE tenants SET status = ? WHERE id = ?", [
      status,
      tenant.tenantId,
    ]);
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("refused-send");
    // A number that genuinely sends, so a refusal is the only thing that
    // keeps a reply off the fake network.
    await run("DELETE FROM channel_accounts WHERE id = ?", [
      tenant.channelAccountId,
    ]);
    const account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: tenant.phoneNumberId,
      accessToken: "EAAG-a-real-looking-token",
    });
    tenant.channelAccountId = account.id;
    ref = {
      tenantId: tenant.tenantId,
      channelAccountId: account.id,
      phoneNumber: CUSTOMER,
    };
    await insertConversation(ref);

    alerts = [];
    eventBus.on("escalation_triggered", onAlert);

    requests = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(JSON.stringify({ messages: [{ id: "wamid-ok" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    eventBus.off("escalation_triggered", onAlert);
    globalThis.fetch = originalFetch;
  });

  describe("for a tenant that is not active", () => {
    it("records a failed outbox row, and says nothing to the customer", async () => {
      await setTenantStatus("suspended");

      const outcome = await WhatsAppService.sendMessage(ref, "¿Sigue ahí?", {
        retry: true,
      });

      expect(outcome).toMatchObject({
        ok: false,
        kind: "permanent",
        reason: "tenant_not_active",
      });
      expect(requests).toBe(0);
      expect(await outboundStatuses(ref)).toEqual(["failed"]);
      expect(await outboxOf(ref)).toMatchObject([
        {
          status: "failed",
          attempts: 1,
          last_kind: "permanent",
          last_reason: "tenant_not_active",
          handed_off_at: null,
        },
      ]);
    });

    it("alerts nobody while it stays suspended", async () => {
      await setTenantStatus("suspended");
      await WhatsAppService.sendMessage(ref, "¿Sigue ahí?", { retry: true });

      await sweepAt();

      expect(alerts).toEqual([]);
      expect((await outboxOf(ref))[0]!.handed_off_at).toBeNull();
      expect((await conversationOf(ref)).status).toBe("active");
      expect(requests).toBe(0);
    });

    it("hands the conversation to a person once, when the tenant reopens", async () => {
      await setTenantStatus("suspended");
      await WhatsAppService.sendMessage(ref, "¿Sigue ahí?", { retry: true });
      await sweepAt();

      await setTenantStatus("active");
      await sweepAt();
      await sweepAt();

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.payload).toMatchObject({
        reason: "reply_undeliverable",
        phoneNumber: CUSTOMER,
      });
      expect((await outboxOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
      expect(await conversationOf(ref)).toMatchObject({
        handover_reason: "reply_undeliverable",
      });
      expect(requests).toBe(0);
    });

    it("keeps a manual reply out of the outbox, so the agent sees the error", async () => {
      await setTenantStatus("suspended");

      const outcome = await WhatsAppService.sendMessage(ref, "Buenas tardes");

      expect(outcome).toMatchObject({
        ok: false,
        kind: "permanent",
        reason: "tenant_not_active",
      });
      expect(await outboxOf(ref)).toEqual([]);
      expect(await outboundStatuses(ref)).toEqual(["failed"]);

      await setTenantStatus("active");
      await sweepAt();
      expect(alerts).toEqual([]);
    });
  });

  /**
   * `messages` and `outbox` both reference the pair (channel account, tenant)
   * and the conversation. A ref that names no account, or an account of another
   * tenant, names no conversation either, so no row can record the reply and
   * no handoff can find one.
   */
  describe("for a ref no row can describe", () => {
    let other: TenantFixture | undefined;

    const cases = [
      {
        name: "an account that does not exist",
        reason: "account_not_found",
        refusedRef: () => ({
          tenantId: tenant.tenantId,
          channelAccountId: "ch-missing",
          phoneNumber: CUSTOMER,
        }),
      },
      {
        name: "an account of another tenant",
        reason: "tenant_mismatch",
        refusedRef: async () => {
          other = await createTenantFixture("refused-send-other");
          return {
            tenantId: tenant.tenantId,
            channelAccountId: other.channelAccountId,
            phoneNumber: CUSTOMER,
          };
        },
      },
    ];

    for (const { name, reason, refusedRef } of cases) {
      for (const retry of [true, false]) {
        it(`refuses ${name} as a permanent outcome${retry ? " for a bot reply" : " for a manual reply"}, and writes nothing`, async () => {
          const refused = await refusedRef();
          const before = await messageCount();

          const outcome = await WhatsAppService.sendMessage(refused, "hola", {
            retry,
          });

          expect(outcome).toMatchObject({
            ok: false,
            kind: "permanent",
            reason,
          });
          expect(requests).toBe(0);
          expect(await messageCount()).toBe(before);
          expect(await outboxOf(refused)).toEqual([]);
        });
      }

      it(`logs ${name} at error level, naming the account`, async () => {
        const refused = await refusedRef();

        const warnings = await logsDuring("warn", async () => {
          await WhatsAppService.sendMessage(refused, "hola", { retry: true });
        });

        expect(
          warnings.filter((line) => line.level === "error"),
        ).toContainEqual(
          expect.objectContaining({
            channelAccountId: refused.channelAccountId,
          }),
        );
      });
    }

    afterEach(async () => {
      other = undefined;
    });
  });

  describe("for an account that is switched off", () => {
    it("throws, queues nothing, alerts nobody, and logs which account", async () => {
      await setChannelStatus(tenant.channelAccountId, "disabled");

      let error: unknown;
      const warnings = await logsDuring("warn", async () => {
        error = await WhatsAppService.sendMessage(ref, "¿Sigue ahí?", {
          retry: true,
        }).catch((caught) => caught);
      });

      expect(error).toBeInstanceOf(ChannelUnavailableError);
      expect(requests).toBe(0);
      expect(await outboxOf(ref)).toEqual([]);
      expect(warnings).toContainEqual(
        expect.objectContaining({
          channelAccountId: tenant.channelAccountId,
          status: "disabled",
        }),
      );

      await sweepAt();
      expect(alerts).toEqual([]);
    });
  });
});
