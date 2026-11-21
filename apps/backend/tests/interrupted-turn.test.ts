/**
 * A refused send throws `ChannelUnavailableError`, and the aggregator requeues
 * the message. The first attempt must record nothing, and the retry must
 * record it once. A turn that already filed an order is the exception.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { db, getAll, run } from "../src/db/index.ts";
import {
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
  setChannelStatus,
} from "./helpers/tenancy.ts";

import type { ChannelAccount, ConversationRef } from "@vendeya/types";

import { conversationStub } from "../src/conversation/stub.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import { VariantService } from "../src/domains/catalog/variants.ts";
import { StockService } from "../src/domains/stock/index.ts";
import { eventBus } from "../src/shared/events/index.ts";
import {
  DEFAULT_REPLY,
  type FakeModel,
  fakeModel,
  withOpenAiKey,
} from "./helpers/model.ts";

const CUSTOMER = "51900777001";

describe("a send refused partway through a turn", () => {
  let tenant: TenantFixture;
  /** A number that genuinely sends: active, with a token behind it. */
  let account: ChannelAccount;
  let ref: ConversationRef;
  let sends: number;
  /** Runs inside the send that makes this count, before it answers. */
  let onSend: (count: number) => Promise<void>;
  /** Runs inside a read receipt, before it answers. */
  let onReceipt: () => Promise<void>;
  let originalFetch: typeof globalThis.fetch;
  let model: FakeModel;

  async function setStatus(status: ChannelAccount["status"]): Promise<void> {
    await setChannelStatus(account.id, status);
  }

  async function answerQueued(): Promise<void> {
    await conversationStub(ref).wake(ref);
  }

  async function queue(text: string): Promise<void> {
    await run(
      `INSERT INTO message_inbox
         (tenant_id, channel_account_id, phone_number, message_text, message_id,
          whatsapp_timestamp, status, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)`,
      [
        ref.tenantId,
        ref.channelAccountId,
        ref.phoneNumber,
        text,
        `wamid-${crypto.randomUUID()}`,
        Date.now() - 60_000,
      ],
    );
  }

  /**
   * The turn starts while the number is on, and the number is switched off as
   * the turn marks the message read, before the first reply.
   */
  async function answerWithNumberSwitchedOffMidFlight(): Promise<void> {
    onReceipt = async () => {
      onReceipt = async () => {};
      await setStatus("disabled");
    };
    await answerQueued();
  }

  async function queueStatuses(): Promise<string[]> {
    return (
      (await getAll(
        "SELECT status FROM message_inbox WHERE channel_account_id = ? ORDER BY id",
        [account.id],
      )) as Array<{ status: string }>
    ).map((row) => row.status);
  }

  async function outbound(): Promise<
    Array<{ content: string; status: string }>
  > {
    return (await MessageStore.getHistory(ref, 100))
      .filter((m) => m.direction === "outbound")
      .reverse()
      .map((m) => ({ content: m.content, status: m.status }));
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("interrupted");
    account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: `pnid-${crypto.randomUUID().slice(0, 8)}`,
      accessToken: "EAAG-a-real-looking-token",
      appSecret: TEST_APP_SECRET,
    });
    ref = {
      tenantId: tenant.tenantId,
      channelAccountId: account.id,
      phoneNumber: CUSTOMER,
    };

    sends = 0;
    onSend = async () => {};
    onReceipt = async () => {};
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (JSON.parse(String(init?.body ?? "{}")).status === "read") {
        await onReceipt();
        return new Response("{}");
      }
      sends++;
      await onSend(sends);

      return new Response(
        JSON.stringify({ messages: [{ id: `wamid-out-${sends}` }] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    model = fakeModel();
    await withOpenAiKey(tenant.tenantId);
  });

  afterEach(async () => {
    model.restore();
    globalThis.fetch = originalFetch;
  });

  describe("on a customer's message", () => {
    beforeEach(async () => {
      await insertConversation(ref);
      await queue("hola");
    });

    it("leaves the message queued and sends nothing", async () => {
      await answerWithNumberSwitchedOffMidFlight();

      expect(await queueStatuses()).toEqual(["pending"]);
      expect(sends).toBe(0);
    });

    it("answers it, once, when the number comes back", async () => {
      await answerWithNumberSwitchedOffMidFlight();

      await setStatus("active");
      await answerQueued();

      expect(await queueStatuses()).toEqual(["processed"]);
      expect(await outbound()).toEqual([
        { content: DEFAULT_REPLY, status: "failed" },
        { content: DEFAULT_REPLY, status: "sent" },
      ]);
    });
  });

  /**
   * The order exists once create_order ran. Leaving the message queued would
   * answer it again and file a second order, so the turn is recorded without
   * its reply and staff learn of the order from its event.
   */
  describe("on a turn that filed an order", () => {
    let announced: number;
    const countOrder = () => {
      announced++;
    };

    async function orders(): Promise<number> {
      return (
        await db
          .selectFrom("orders")
          .select("id")
          .where("tenant_id", "=", ref.tenantId)
          .execute()
      ).length;
    }

    beforeEach(async () => {
      await insertConversation(ref);
      const product = await ProductService.create({
        tenantId: tenant.tenantId,
        name: "Cocina 4 hornillas",
        category: "cocinas",
      });
      const variant = await VariantService.create(tenant.tenantId, product.id, {
        name: null,
        sku: "COC-4",
        price_cents: 120_000,
        cost_cents: null,
        is_active: 1,
      });
      const location = await StockService.defaultLocation(tenant.tenantId);
      await StockService.record({
        tenantId: tenant.tenantId,
        variantId: variant.id,
        locationId: location!.id,
        kind: "receive",
        quantity: 5,
        createdBy: null,
      });
      model.calls({
        name: "create_order",
        arguments: {
          customer_name: "Juan Pérez",
          document_type: "dni",
          document_number: "12345678",
          lines: [{ variant_id: variant.id, quantity: 1 }],
          address: null,
          zone_id: null,
          payment_method_id: null,
          notes: null,
        },
      });
      model.says("Listo, tu pedido está registrado.");
      await queue("sí, confirmo");

      announced = 0;
      eventBus.on("order_created", countOrder);
    });

    afterEach(async () => {
      eventBus.off("order_created", countOrder);
    });

    it("records the turn without its reply and announces the order", async () => {
      await answerWithNumberSwitchedOffMidFlight();

      expect(await queueStatuses()).toEqual(["processed"]);
      expect(await orders()).toBe(1);
      expect(announced).toBe(1);
      expect(await outbound()).toEqual([
        { content: "Listo, tu pedido está registrado.", status: "failed" },
      ]);
    });

    it("files no second order when the number comes back", async () => {
      await answerWithNumberSwitchedOffMidFlight();
      const calls = model.requests.length;

      await setStatus("active");
      await answerQueued();

      expect(model.requests.length).toBe(calls);
      expect(await orders()).toBe(1);
      expect(announced).toBe(1);
    });
  });
});
