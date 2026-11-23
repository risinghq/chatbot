/**
 * Covers the work that reaches a tenant's rows without a pinned tenant. Inbox
 * aggregation, customer sends and the reassignment cron run without a session.
 * A platform operator's exports read across tenants. Each path has to check the
 * tenant's status itself, because no pinned scope filters it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as XLSX from "xlsx";

import { getOne, run } from "./helpers/db.ts";
import {
  createTenantFixture,
  createMember,
  fileOrder,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import {
  conversationsWithWaitingMessages,
  pendingGroup,
} from "../src/conversation/message-inbox.ts";
import { conversationStub } from "../src/conversation/stub.ts";
import { checkAndReassignTimeouts } from "../src/domains/conversations/assignment.ts";
import { ReportService } from "../src/domains/reports/index.ts";
import { WhatsAppService } from "../src/adapters/whatsapp/index.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { CloudApiAdapter } from "../src/adapters/whatsapp/cloud-api.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import type { ChannelAccount } from "@vendeya/types";

const CUSTOMER = "51900222333";

describe("a suspended tenant", () => {
  let open: TenantFixture;
  let closed: TenantFixture;

  async function suspend(tenantId: string): Promise<void> {
    await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
      tenantId,
    ]);
  }

  async function queueMessage(
    fixture: TenantFixture,
    text: string,
  ): Promise<void> {
    await run(
      `INSERT INTO message_inbox
         (tenant_id, channel_account_id, phone_number, message_text, message_id,
          whatsapp_timestamp, status, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)`,
      [
        fixture.tenantId,
        fixture.channelAccountId,
        CUSTOMER,
        text,
        `wamid-${crypto.randomUUID()}`,
        Date.now() - 60_000,
      ],
    );
  }

  beforeEach(async () => {
    open = await createTenantFixture("open-biz");
    closed = await createTenantFixture("closed-biz");
  });

  describe("stops the aggregator from answering what was already queued", () => {
    it("leaves its pending messages out of the group and the sweep", async () => {
      await queueMessage(open, "hola");
      await queueMessage(closed, "hola");

      const waiting = async () =>
        (await conversationsWithWaitingMessages(Date.now())).map(
          (ref) => ref.tenantId,
        );
      expect(await waiting()).toEqual(
        expect.arrayContaining([open.tenantId, closed.tenantId]),
      );

      await suspend(closed.tenantId);

      expect(await waiting()).not.toContain(closed.tenantId);
      expect(await pendingGroup(closed.ref(CUSTOMER))).toBeUndefined();
      // The other business is still being served.
      expect(await waiting()).toContain(open.tenantId);
      expect(await pendingGroup(open.ref(CUSTOMER))).toBeDefined();
    });

    it("leaves them pending rather than dropping them", async () => {
      await queueMessage(closed, "hola");
      await suspend(closed.tenantId);

      await conversationStub(closed.ref(CUSTOMER)).wake(closed.ref(CUSTOMER));

      // Reactivating the tenant has to resume where it left off, so the row is
      // skipped, not consumed.
      expect(
        await getOne(
          "SELECT status FROM message_inbox WHERE tenant_id = ? LIMIT 1",
          [closed.tenantId],
        ),
      ).toEqual({ status: "pending" });
    });
  });

  /**
   * `resolveAccount` gates every customer-facing send. The account is `active`
   * and has a real token, so without the tenant check the adapter would call
   * Meta. The tests assert that no request is made.
   */
  describe("sends nothing on a customer conversation", () => {
    let sends: number;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(async () => {
      sends = 0;
      originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        sends++;
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid-sent" }] }),
          { headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof globalThis.fetch;
    });

    afterEach(async () => {
      globalThis.fetch = originalFetch;
    });

    /** A number that is genuinely able to send: active, with a token. */
    async function sendableRef(fixture: TenantFixture) {
      const account = await ChannelAccountService.create({
        tenantId: fixture.tenantId,
        phoneNumberId: `pnid-${crypto.randomUUID().slice(0, 8)}`,
        accessToken: "EAAG-a-real-looking-token",
        appSecret: TEST_APP_SECRET,
      });
      const ref = {
        tenantId: fixture.tenantId,
        channelAccountId: account.id,
        phoneNumber: CUSTOMER,
      };
      await insertConversation(ref);
      return ref;
    }

    it("makes no request, and records the reply as failed", async () => {
      const ref = await sendableRef(closed);

      await suspend(closed.tenantId);
      await WhatsAppService.sendMessage(ref, "¿Sigue ahí?");

      expect(sends).toBe(0);

      const history = await MessageStore.getHistory(ref);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        direction: "outbound",
        status: "failed",
      });
    });

    it("still sends for a tenant that is open", async () => {
      const ref = await sendableRef(open);

      await WhatsAppService.sendMessage(ref, "¿Sigue ahí?");

      expect(sends).toBe(1);
      expect((await MessageStore.getHistory(ref))[0]).toMatchObject({
        status: "sent",
      });
    });
  });

  describe("stops the reassignment cron", () => {
    /** A conversation whose agent was paged and never answered. */
    async function timedOut(
      fixture: TenantFixture,
      agentId: string,
    ): Promise<void> {
      await insertConversation(fixture.ref(CUSTOMER), {
        status: "human_takeover",
        assignedAgent: agentId,
      });
      await run(
        `UPDATE conversations
         SET assignment_notified_at = ?, handover_reason = NULL
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [
          Date.now() - 10 * 60 * 1000,
          fixture.tenantId,
          fixture.channelAccountId,
          CUSTOMER,
        ],
      );
    }

    async function assignmentOf(fixture: TenantFixture) {
      return (await getOne(
        `SELECT assigned_agent, assignment_notified_at FROM conversations
           WHERE tenant_id = ? AND phone_number = ?`,
        [fixture.tenantId, CUSTOMER],
      )) as {
        assigned_agent: string | null;
        assignment_notified_at: number | null;
      };
    }

    it("leaves its conversations assigned where they are", async () => {
      const closedAgent = await createMember(closed, "sales_agent");
      const openAgent = await createMember(open, "sales_agent");

      await timedOut(closed, closedAgent.userId);
      await timedOut(open, openAgent.userId);

      const staleNotifiedAt = (await assignmentOf(closed))
        .assignment_notified_at;

      await suspend(closed.tenantId);

      await checkAndReassignTimeouts();

      // The assignment is not cleared, so no agent of a closed business is
      // paged for a conversation it cannot answer.
      expect(await assignmentOf(closed)).toEqual({
        assigned_agent: closedAgent.userId,
        assignment_notified_at: staleNotifiedAt,
      });

      // The cron still processes the open tenant: its agent is notified again
      // just now.
      expect((await assignmentOf(open)).assigned_agent).toBe(openAgent.userId);
      expect((await assignmentOf(open)).assignment_notified_at).toBeGreaterThan(
        staleNotifiedAt!,
      );
    });
  });

  describe("is left out of a platform operator's exports", () => {
    const range = {
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };

    /** The rows an .xlsx file actually carries. */
    function rowsOf(file: ArrayBuffer): Array<Record<string, unknown>> {
      const workbook = XLSX.read(file, { type: "array" });

      const sheet = workbook.Sheets[workbook.SheetNames[0]!]!;
      return XLSX.utils.sheet_to_json(sheet);
    }

    it("out of the activity report", async () => {
      await insertConversation(open.ref(CUSTOMER), {
        clientName: "Open Client",
      });
      await insertConversation(closed.ref(CUSTOMER), {
        clientName: "Closed Client",
      });

      await suspend(closed.tenantId);

      const names = rowsOf(
        await ReportService.generateActivityReport({
          tenantId: null,
          ...range,
        }),
      ).map((row) => row.Cliente);

      expect(names).toContain("Open Client");
      expect(names).not.toContain("Closed Client");
    });

    it("out of the order report", async () => {
      for (const fixture of [open, closed]) {
        await insertConversation(fixture.ref(CUSTOMER));
        await fileOrder(fixture.ref(CUSTOMER), {
          name: fixture === open ? "Open Buyer" : "Closed Buyer",
        });
      }

      await suspend(closed.tenantId);

      const buyers = rowsOf(
        await ReportService.generateOrderReport({
          tenantId: null,
          ...range,
        }),
      ).map((row) => row.Cliente);

      expect(buyers).toContain("Open Buyer");
      expect(buyers).not.toContain("Closed Buyer");
    });
  });
});

/**
 * The Cloud API adapter refuses any account that is not `active` before it
 * builds a request, so a half-configured number never reaches Meta.
 */
describe("the Cloud API adapter", () => {
  let tenant: TenantFixture;
  let account: ChannelAccount;
  let calls: number;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tenant = await createTenantFixture("cloud-adapter");
    account = (await ChannelAccountService.getById(tenant.channelAccountId))!;

    calls = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ messages: [{ id: "m-1" }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
  });

  for (const status of ["pending", "disabled"] as const) {
    it(`refuses to send for a ${status} account`, async () => {
      const inactive = { ...account, status };

      const refused = {
        ok: false as const,
        kind: "permanent" as const,
        reason: "account_not_active",
      };
      expect(
        await CloudApiAdapter.sendMessage(inactive, CUSTOMER, "hola"),
      ).toEqual(refused);
      expect(
        await CloudApiAdapter.sendImage(inactive, CUSTOMER, "images/x.jpg"),
      ).toEqual(refused);

      // The refusal happens before any request. The send did not fail on the
      // wire.
      expect(calls).toBe(0);
    });
  }
});
