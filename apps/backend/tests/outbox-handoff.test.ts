/**
 * A reply that ends `failed` leaves the customer without an answer, so the
 * conversation goes to a person. Each test runs the real cron sweep, which
 * wakes every conversation that is due, with a clock it controls. The only
 * fake is the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAll, getOne, run } from "../src/db/index.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import type { ConversationMetadata, ConversationPhase } from "@vendeya/core";
import type { ConversationRef, DomainEvent } from "@vendeya/types";

import { executeCommands } from "../src/conversation/handler/command-executor.ts";
import { WhatsAppService } from "../src/adapters/whatsapp/index.ts";
import { MAX_AGE_MS, type OutboxRow } from "../src/conversation/outbox.ts";
import { logsDuring } from "./helpers/logs.ts";
import { sweepAt } from "./helpers/turn.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { notificationRules } from "../src/domains/notifications/config.ts";
import { evaluateNotifications } from "../src/domains/notifications/evaluator.ts";
import { takeoverConversation } from "../src/domains/conversations/write.ts";
import { eventBus } from "../src/shared/events/index.ts";

const CUSTOMER = "51900999001";
const OTHER_CUSTOMER = "51900999002";

type ConversationState = {
  status: string;
  handover_reason: string | null;
  phase: ConversationPhase;
};

describe("handing a conversation to a person when a reply cannot be delivered", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let agent: string;
  let originalFetch: typeof globalThis.fetch;
  let answer: () => Response;
  /** The `escalation_triggered` events this tenant's conversations emitted. */
  let alerts: DomainEvent[];

  const accepted = () =>
    new Response(JSON.stringify({ messages: [{ id: "wamid-ok" }] }), {
      headers: { "Content-Type": "application/json" },
    });
  /** A 502 with an HTML body: the adapter classifies it `transient`. */
  const unreachable = () =>
    new Response("<html>Bad gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
  /** Meta's re-engagement error: the adapter classifies it `permanent`. */
  const refused = () =>
    new Response(JSON.stringify({ error: { code: 131047 } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  /** A reset connection: the adapter classifies it `ambiguous`. */
  const reset = (): Response => {
    throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  };

  const onAlert = (event: DomainEvent) => {
    if (event.tenantId === tenant.tenantId) alerts.push(event);
  };

  async function rowsOf(of: ConversationRef): Promise<OutboxRow[]> {
    return (await getAll(
      `SELECT * FROM outbox
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
         ORDER BY id`,
      [of.tenantId, of.channelAccountId, of.phoneNumber],
    )) as OutboxRow[];
  }

  async function message(id: string): Promise<{ status: string }> {
    return (await getOne("SELECT status FROM messages WHERE id = ?", [id])) as {
      status: string;
    };
  }

  async function conversationOf(
    of: ConversationRef,
  ): Promise<ConversationState> {
    const row = (await getOne(
      `SELECT status, handover_reason, context_data FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [of.tenantId, of.channelAccountId, of.phoneNumber],
    )) as {
      status: string;
      handover_reason: string | null;
      context_data: string;
    };
    return {
      status: row.status,
      handover_reason: row.handover_reason,
      phase: JSON.parse(row.context_data).phase,
    };
  }

  async function assignmentOf(of: ConversationRef) {
    return (await getOne(
      `SELECT assigned_agent, assignment_notified_at FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [of.tenantId, of.channelAccountId, of.phoneNumber],
    )) as {
      assigned_agent: string | null;
      assignment_notified_at: number | null;
    };
  }

  /** Queue one reply by letting its inline send fail the way `answer` says. */
  async function queue(text: string, of = ref): Promise<OutboxRow> {
    const before = (await rowsOf(of)).length;
    await WhatsAppService.sendMessage(of, text, { retry: true });
    const queued = await rowsOf(of);
    expect(queued).toHaveLength(before + 1);
    return queued[before]!;
  }

  /**
   * Leaves a row `failed` with no handoff, as a crash between the failure and
   * the handoff would. The worker pass that fails a row also hands it off, so a
   * test that needs the gap writes the state itself.
   */
  async function failWithoutHandoff(
    row: OutboxRow,
    reason = "expired",
  ): Promise<void> {
    await run(
      "UPDATE outbox SET status = 'failed', last_reason = ? WHERE id = ?",
      [reason, row.id],
    );
    await run("UPDATE messages SET status = 'failed' WHERE id = ?", [
      row.message_id,
    ]);
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("outbox-handoff");
    // A number that genuinely sends, so the adapter reaches the fake network.
    await run("DELETE FROM channel_accounts WHERE id = ?", [
      tenant.channelAccountId,
    ]);
    const account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: tenant.phoneNumberId,
      accessToken: "EAAG-a-real-looking-token",
      appSecret: TEST_APP_SECRET,
    });
    tenant.channelAccountId = account.id;
    ref = {
      tenantId: tenant.tenantId,
      channelAccountId: account.id,
      phoneNumber: CUSTOMER,
    };
    await insertConversation(ref);
    agent = (await createMember(tenant, "sales_agent")).userId;

    alerts = [];
    eventBus.on("escalation_triggered", onAlert);

    answer = accepted;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => answer()) as unknown as typeof fetch;
  });

  afterEach(async () => {
    vi.useRealTimers();
    eventBus.off("escalation_triggered", onAlert);
    await run("DROP TRIGGER IF EXISTS refuse_handoff_test");
    await run("DROP TRIGGER IF EXISTS refuse_stamp_test");
    globalThis.fetch = originalFetch;
    await run("DELETE FROM audit_log WHERE user_id = ?", [agent]);
  });

  describe("every route to a failed row", () => {
    /**
     * Each route queues two replies, so the second one is still pending when the
     * first fails. It runs the passes that fail the first row.
     */
    const routes: Array<{
      name: string;
      lastReason: string;
      queueWith: () => Response;
      failFirst: (first: OutboxRow, second: OutboxRow) => Promise<void>;
    }> = [
      {
        name: "five transient failures",
        lastReason: "exhausted",
        queueWith: unreachable,
        failFirst: async () => {
          for (let pass = 0; pass < 4; pass++) {
            expect((await rowsOf(ref))[0]!.status).toBe("pending");
            expect(alerts).toEqual([]);
            await sweepAt((await rowsOf(ref))[0]!.next_attempt_at);
          }
        },
      },
      {
        name: "expiry",
        lastReason: "expired",
        queueWith: unreachable,
        failFirst: async (first, second) => {
          // The second reply is younger than the age limit, so only the first expires.
          await run("UPDATE outbox SET created_at = ? WHERE id = ?", [
            first.created_at + 1_000,
            second.id,
          ]);
          await sweepAt(first.created_at + MAX_AGE_MS);
        },
      },
      {
        name: "a refusal for good on a retry",
        lastReason: "http_400:131047",
        queueWith: unreachable,
        failFirst: async (first) => {
          answer = refused;
          await sweepAt(first.next_attempt_at);
        },
      },
      {
        name: "a second ambiguous outcome",
        lastReason: "network:ECONNRESET",
        queueWith: reset,
        failFirst: async (first) => {
          await sweepAt(first.next_attempt_at);
        },
      },
    ];

    for (const route of routes) {
      it(`hands the conversation off within the pass that ends in ${route.name}`, async () => {
        answer = route.queueWith;
        const first = await queue("primero");
        const second = await queue("segundo");

        await route.failFirst(first, second);

        expect((await rowsOf(ref))[0]).toMatchObject({
          status: "failed",
          last_reason: route.lastReason,
        });
        expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
        expect((await message(first.message_id)).status).toBe("failed");

        expect(await conversationOf(ref)).toMatchObject({
          status: "human_takeover",
          handover_reason: "reply_undeliverable",
          phase: { phase: "escalated", reason: "reply_undeliverable" },
        });

        expect((await assignmentOf(ref)).assigned_agent).toBe(agent);
        expect(
          (await assignmentOf(ref)).assignment_notified_at,
        ).toBeGreaterThan(0);

        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          type: "escalation_triggered",
          tenantId: ref.tenantId,
          channelAccountId: ref.channelAccountId,
          payload: {
            phoneNumber: CUSTOMER,
            reason: "reply_undeliverable",
            context: { failedReplies: 1, lastReason: route.lastReason },
          },
        });

        expect((await rowsOf(ref))[1]).toMatchObject({
          id: second.id,
          status: "cancelled",
          handed_off_at: null,
        });
        expect((await message(second.message_id)).status).toBe("cancelled");
      });
    }

    it("changes nothing and emits nothing on a second pass", async () => {
      answer = unreachable;
      const first = await queue("primero");
      await queue("segundo");
      await sweepAt(first.created_at + MAX_AGE_MS);
      expect(alerts).toHaveLength(1);

      const rows = await rowsOf(ref);
      const conversation = await conversationOf(ref);

      await sweepAt(first.created_at + MAX_AGE_MS + 60_000);
      await sweepAt(first.created_at + MAX_AGE_MS + 120_000);

      expect(alerts).toHaveLength(1);
      expect(await rowsOf(ref)).toEqual(rows);
      expect(await conversationOf(ref)).toEqual(conversation);
    });

    it("hands off a reply refused for good on the first inline send, which is kept as a failed row", async () => {
      answer = refused;
      await WhatsAppService.sendMessage(ref, "hola", { retry: true });
      expect((await rowsOf(ref))[0]).toMatchObject({
        status: "failed",
        attempts: 1,
        handed_off_at: null,
      });

      await sweepAt();

      expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
      expect((await conversationOf(ref)).handover_reason).toBe(
        "reply_undeliverable",
      );
      expect(alerts).toHaveLength(1);
    });
  });

  describe("a conversation a person or the bot already holds", () => {
    const metadata = {
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    } as ConversationMetadata;

    it("keeps the state and reason the bot escalated with, and still sends one alert", async () => {
      answer = unreachable;
      // The advisor message is the reply that never goes out.
      await executeCommands(
        {
          type: "update",
          nextPhase: {
            phase: "escalated",
            reason: "multiple_objections",
          } as ConversationPhase,
          commands: [
            {
              type: "SEND_MESSAGE",
              text: "Un asesor te contactará en breve",
            },
          ],
        },
        ref,
        metadata,
        false,
        "trace",
      );
      const advisorMessage = (await rowsOf(ref))[0]!;
      const before = await conversationOf(ref);
      expect(before).toMatchObject({
        status: "human_takeover",
        handover_reason: "multiple_objections",
      });

      await sweepAt(advisorMessage.created_at + MAX_AGE_MS);

      expect((await rowsOf(ref))[0]).toMatchObject({ status: "failed" });
      expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
      expect(await conversationOf(ref)).toEqual(before);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.payload).toMatchObject({
        reason: "reply_undeliverable",
      });
    });

    it("keeps the reason of a person's takeover, and still sends one alert", async () => {
      answer = unreachable;
      const failed = await queue("primero");
      await failWithoutHandoff(failed);
      await takeoverConversation(ref, agent);
      const before = await conversationOf(ref);
      expect(before.handover_reason).toBe("Manual takeover by agent");

      await sweepAt();

      expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
      expect(await conversationOf(ref)).toEqual(before);
      expect(alerts).toHaveLength(1);
    });
  });

  it("sends one alert for two rows that fail together, and marks both", async () => {
    answer = unreachable;
    await queue("primero");
    const second = await queue("segundo");

    await sweepAt(second.created_at + MAX_AGE_MS);

    expect((await rowsOf(ref)).map((row) => row.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(
      (await rowsOf(ref)).map((row) => row.handed_off_at !== null),
    ).toEqual([true, true]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({
      context: { failedReplies: 2, lastReason: "expired" },
    });
  });

  it("leaves a suspended tenant alone until it reopens", async () => {
    answer = unreachable;
    const failed = await queue("primero");
    const behind = await queue("segundo");
    await failWithoutHandoff(failed);
    await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
      tenant.tenantId,
    ]);

    await sweepAt();

    expect((await rowsOf(ref))[0]!.handed_off_at).toBeNull();
    expect((await rowsOf(ref))[1]!.status).toBe("pending");
    expect((await conversationOf(ref)).status).toBe("active");
    expect(alerts).toEqual([]);

    await run("UPDATE tenants SET status = 'active' WHERE id = ?", [
      tenant.tenantId,
    ]);
    await sweepAt();

    expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
    expect((await rowsOf(ref))[1]!.status).toBe("cancelled");
    expect((await message(behind.message_id)).status).toBe("cancelled");
    expect((await conversationOf(ref)).handover_reason).toBe(
      "reply_undeliverable",
    );
    expect(alerts).toHaveLength(1);
  });

  describe("when the sweep finds it", () => {
    it("hands off a failed row that was never handed off", async () => {
      answer = unreachable;
      const failed = await queue("primero");
      await failWithoutHandoff(failed);

      await sweepAt();

      expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
      expect((await conversationOf(ref)).handover_reason).toBe(
        "reply_undeliverable",
      );
      expect(alerts).toHaveLength(1);
    });

    it("hands off a row that a new object's recovery fails as a second ambiguous outcome", async () => {
      answer = reset;
      const row = await queue("primero");
      expect(row.ambiguous_attempts).toBe(1);
      await run("UPDATE outbox SET status = 'sending' WHERE id = ?", [row.id]);

      await sweepAt();

      expect((await rowsOf(ref))[0]).toMatchObject({
        status: "failed",
        last_reason: "interrupted",
      });
      expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
      expect(alerts).toHaveLength(1);
    });
  });

  it("emits the alert before it stamps the rows, so a failure in between costs a second alert and never a missed one", async () => {
    answer = unreachable;
    const failed = await queue("primero");
    await failWithoutHandoff(failed);
    await run(`CREATE TRIGGER refuse_stamp_test BEFORE UPDATE OF handed_off_at ON outbox
       BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`);

    await logsDuring("error", () => sweepAt());

    expect(alerts).toHaveLength(1);
    expect((await rowsOf(ref))[0]!.handed_off_at).toBeNull();
    expect((await conversationOf(ref)).handover_reason).toBe(
      "reply_undeliverable",
    );

    await run("DROP TRIGGER refuse_stamp_test");
    await sweepAt();

    expect(alerts).toHaveLength(2);
    expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);

    await sweepAt();
    expect(alerts).toHaveLength(2);
  });

  it("does not let one conversation's error stop another's handoff, and names the ids", async () => {
    answer = unreachable;
    const broken = await queue("primero");
    const otherRef = { ...ref, phoneNumber: OTHER_CUSTOMER };
    await insertConversation(otherRef);
    const healthy = await queue("primero", otherRef);
    await failWithoutHandoff(broken);
    await failWithoutHandoff(healthy);

    await run(`CREATE TRIGGER refuse_handoff_test BEFORE UPDATE ON conversations
       WHEN NEW.phone_number = '${CUSTOMER}' AND NEW.status = 'human_takeover'
       BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`);

    const logs = await logsDuring("error", () => sweepAt());

    expect((await rowsOf(otherRef))[0]!.handed_off_at).toBeGreaterThan(0);
    expect((await conversationOf(otherRef)).handover_reason).toBe(
      "reply_undeliverable",
    );
    expect(alerts).toHaveLength(1);

    expect((await rowsOf(ref))[0]!.handed_off_at).toBeNull();
    expect((await conversationOf(ref)).status).toBe("active");

    const failure = logs.find((entry) => entry.module === "handoff");
    expect(failure).toMatchObject({
      tenantId: ref.tenantId,
      channelAccountId: ref.channelAccountId,
      outboxIds: [broken.id],
    });
    expect(JSON.stringify(failure)).not.toContain(CUSTOMER);

    // Nothing was lost: the next pass, with the fault gone, finishes the job.
    await run("DROP TRIGGER refuse_handoff_test");
    await sweepAt();

    expect((await rowsOf(ref))[0]!.handed_off_at).toBeGreaterThan(0);
    expect((await conversationOf(ref)).handover_reason).toBe(
      "reply_undeliverable",
    );
    expect(alerts).toHaveLength(2);
  });

  describe("the alert the advisor reads", () => {
    it("says in Spanish that a reply could not be delivered", async () => {
      const decisions = evaluateNotifications(
        {
          type: "escalation_triggered",
          traceId: "trace-1",
          timestamp: Date.now(),
          tenantId: "tn-1",
          channelAccountId: "ch-1",
          payload: {
            phoneNumber: CUSTOMER,
            reason: "reply_undeliverable",
            context: { failedReplies: 1, lastReason: "exhausted" },
          },
        },
        notificationRules,
      );
      const sent = decisions.find((decision) => decision.status === "sent");

      expect(sent?.status === "sent" && sent.content).toContain(
        "Motivo: No se pudo entregar una respuesta al cliente",
      );
    });
  });
});
