/**
 * A refused send throws `ChannelUnavailableError`, and the aggregator requeues
 * the message. The first attempt must record nothing (no new phase, TRACK_EVENT
 * rows or domain events), and the retry must record each exactly once.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getAll, getOne, run } from "../src/db/index.ts";
import {
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
  setChannelStatus,
} from "./helpers/tenancy.ts";

import { GREETING } from "@vendeya/core";
import type {
  ConversationMetadata,
  ConversationPhase,
  TransitionResult,
} from "@vendeya/core";
import type { ChannelAccount, ConversationRef } from "@vendeya/types";

import { conversationStub } from "../src/conversation/stub.ts";
import { executeCommands } from "../src/conversation/handler/command-executor.ts";
import { ChannelUnavailableError } from "../src/adapters/whatsapp/index.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { BundleService } from "../src/domains/catalog/bundles.ts";
import { eventBus } from "../src/shared/events/index.ts";

const CUSTOMER = "51900777001";

describe("a send refused partway through a transition", () => {
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
  let originalRandom: typeof Math.random;

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

  async function storedPhase(): Promise<ConversationPhase> {
    const row = (await getOne(
      `SELECT context_data FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    )) as {
      context_data: string;
    };
    return JSON.parse(row.context_data).phase;
  }

  async function analytics(eventType: string): Promise<number> {
    return (
      (await getOne(
        `SELECT COUNT(*) as c FROM analytics_events
           WHERE channel_account_id = ? AND phone_number = ? AND event_type = ?`,
        [account.id, CUSTOMER, eventType],
      )) as { c: number }
    ).c;
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
    originalRandom = Math.random;
    // Fix the one-message purchase-confirmation variant so this test does not
    // depend on pacing sleeps.
    Math.random = () => 0.999999;
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
  });

  afterEach(async () => {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  });

  /**
   * A new contact says "hola". The greeting transition lists `session_start`
   * before its sends, and the number is switched off after the dequeue and
   * before the first send.
   */
  describe("on a new contact's first message", () => {
    beforeEach(async () => {
      await queue("hola");
    });

    it("neither moves the conversation on nor counts a session", async () => {
      await answerWithNumberSwitchedOffMidFlight();

      expect(await queueStatuses()).toEqual(["pending"]);
      // The phase stays `greeting`. `confirming_client` would read the next
      // "hola" as the answer to a question never asked.
      expect(await storedPhase()).toEqual({ phase: "greeting" });
      expect(await analytics("session_start")).toBe(0);
      expect(sends).toBe(0);
    });

    it("greets them, once, when the number comes back", async () => {
      await answerWithNumberSwitchedOffMidFlight();

      await setStatus("active");
      await answerQueued();

      expect(await queueStatuses()).toEqual(["processed"]);
      expect(await storedPhase()).toEqual({ phase: "confirming_client" });
      expect(await analytics("session_start")).toBe(1);

      const greetings = GREETING.flat();
      const last = (await outbound()).at(-1);
      expect(last?.status).toBe("sent");
      expect(greetings).toContain(last?.content ?? "");
    });
  });

  /**
   * `purchase_confirmed` is a domain event the orchestrator emits, and its
   * subscriber creates the order. Emitting it before the sends would make the
   * retry confirm the same sale twice.
   */
  describe("on a purchase confirmation", () => {
    let confirmations: number;
    const countConfirmation = () => {
      confirmations++;
    };

    beforeEach(async () => {
      await insertConversation(ref, {
        contextData: {
          phase: {
            phase: "confirming_selection",
            segment: "fnb",
            credit: 5000,
            name: "Juan",
            selectedProduct: {
              name: "Cocina 4 hornillas",
              price: 1200,
              productId: "prod-cocina",
            },
          },
          metadata: {
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            dni: "12345678",
          },
        },
      });
      await queue("sí");

      confirmations = 0;
      eventBus.on("purchase_confirmed", countConfirmation);
    });

    afterEach(async () => {
      eventBus.off("purchase_confirmed", countConfirmation);
    });

    it("confirms nothing until the confirmation reaches the customer", async () => {
      await answerWithNumberSwitchedOffMidFlight();

      expect(await queueStatuses()).toEqual(["pending"]);
      expect(confirmations).toBe(0);
      expect(await analytics("purchase_confirmed")).toBe(0);
      expect((await storedPhase()).phase).toBe("confirming_selection");
    });

    it("confirms the sale exactly once when the number comes back", async () => {
      await answerWithNumberSwitchedOffMidFlight();

      await setStatus("active");
      await answerQueued();

      expect(await queueStatuses()).toEqual(["processed"]);
      expect(confirmations).toBe(1);
      expect(await analytics("purchase_confirmed")).toBe(1);
      expect((await storedPhase()).phase).toBe("closing");
    });
  });

  describe("in executeCommands itself", () => {
    const metadata = {
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    } as ConversationMetadata;

    /**
     * A message sent before the refusal is not retracted and is sent again on
     * the retry. The phase and the analytics are written once, after the last
     * send, and never for a batch that did not finish.
     */
    it("repeats a message that went out before the refusal, and records nothing until the batch completes", async () => {
      await insertConversation(ref);

      const batch: TransitionResult = {
        type: "update",
        nextPhase: { phase: "confirming_client" },
        commands: [
          { type: "SEND_MESSAGE", text: "uno" },
          { type: "TRACK_EVENT", event: "session_start" },
          { type: "SEND_MESSAGE", text: "dos" },
        ],
      };

      // The first message goes out, and the number is switched off before the
      // second.
      onSend = async (count) => {
        if (count === 1) await setStatus("disabled");
      };

      await expect(
        executeCommands(batch, ref, metadata, false, "trace-1"),
      ).rejects.toThrow(ChannelUnavailableError);

      expect(await outbound()).toEqual([
        { content: "uno", status: "sent" },
        { content: "dos", status: "failed" },
      ]);
      // The TRACK_EVENT sat *between* the two sends and still was not written.
      expect(await analytics("session_start")).toBe(0);
      expect(await storedPhase()).toEqual({ phase: "greeting" });

      onSend = async () => {};
      await setStatus("active");

      await executeCommands(batch, ref, metadata, false, "trace-2");

      expect(await outbound()).toEqual([
        { content: "uno", status: "sent" },
        { content: "dos", status: "failed" },
        // The accepted duplicate.
        { content: "uno", status: "sent" },
        { content: "dos", status: "sent" },
      ]);
      expect(await analytics("session_start")).toBe(1);
      expect(await storedPhase()).toEqual({ phase: "confirming_client" });
    });

    /**
     * Image and bundle commands add `sentProducts` to the phase. Persisting the
     * plain `nextPhase` after the last send would overwrite them, and the next
     * message could not be matched against the products the customer was shown.
     */
    it("keeps the products a bundle command showed on the phase it persists", async () => {
      const periodId = `per-${crypto.randomUUID()}`;
      await run(
        `INSERT INTO catalog_periods (id, tenant_id, name, year_month, status)
         VALUES (?, ?, 'Enero', '2026-01', 'active')`,
        [periodId, tenant.tenantId],
      );

      const bundleId = `bundle-${crypto.randomUUID()}`;
      await BundleService.create({
        id: bundleId,
        tenantId: tenant.tenantId,
        period_id: periodId,
        segment: "fnb",
        name: "Cocina 4 hornillas",
        price: 1200,
        primary_category: "cocinas",
        categories_json: JSON.stringify(["cocinas"]),
        image_id: "abcdef0123456789",
        composition_json: JSON.stringify({ fixed: [], choices: [] }),
        installments_json: JSON.stringify([{ months: 12, monthlyAmount: 110 }]),
        created_by: null,
      });

      await insertConversation(ref);

      await executeCommands(
        {
          type: "update",
          nextPhase: {
            phase: "offering_products",
            segment: "fnb",
            credit: 5000,
            name: "Juan",
          },
          commands: [{ type: "SEND_BUNDLE", bundleId }],
        },
        ref,
        metadata,
        false,
        "trace-bundle",
      );

      expect(await storedPhase()).toMatchObject({
        phase: "offering_products",
        sentProducts: [{ productId: bundleId, position: 1, price: 1200 }],
        lastAction: { type: "showed_products", productCount: 1 },
      });
    });
  });
});
