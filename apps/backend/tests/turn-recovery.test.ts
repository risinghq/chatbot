/**
 * A turn that cannot work out a reply must not leave the customer unanswered
 * and unnoticed. Each test fills the inbox, mostly through a real signed
 * webhook, and wakes the conversation's object, whose pass answers the turn
 * and hands off a failed one. The only fakes are the network and the
 * enrichment step that stands in for the LLM.
 */

import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConversationPhase } from "@vendeya/core";
import type { DomainEvent } from "@vendeya/types";

import { getAll, getOne, run } from "../src/db/index.ts";
import { enrichmentRegistry } from "../src/conversation/enrichment/registry.ts";
import { storeIncomingMessage } from "../src/conversation/message-inbox.ts";
import { conversationStub } from "../src/conversation/stub.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { eventBus } from "../src/shared/events/index.ts";
import {
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { customerWrites } from "./helpers/turn.ts";

const CUSTOMER = "51900888001";

const OBJECTION: ConversationPhase = {
  phase: "handling_objection",
  segment: "fnb",
  credit: 3000,
  name: "Ana",
  objectionCount: 1,
};

/** What the objection phase answers when the message is not a question. */
const FOLLOW_UP = "¿Te gustaría ver alguna otra opción?";

describe("a customer whose turn fails", () => {
  let tenant: TenantFixture;
  let originalFetch: typeof globalThis.fetch;
  /** Replies WhatsApp accepted, in order. */
  let delivered: string[];
  let alerts: DomainEvent[];
  /** Turns that reached the reply step. */
  let attempts: number;
  /** How many of those throw before one succeeds. */
  let failures: number;
  /** Runs inside a reply step attempt, before it throws or answers. */
  let whileAnswering: Record<number, () => Promise<void>>;

  const onAlert = (event: DomainEvent) => {
    if (event.tenantId === tenant.tenantId) alerts.push(event);
  };

  /** The reply step: the first `failures` calls throw, the rest say "not a question". */
  function replyStep() {
    enrichmentRegistry.clear();
    enrichmentRegistry.register({
      type: "detect_question",
      execute: async () => {
        attempts++;
        await whileAnswering[attempts]?.();
        if (attempts <= failures) throw new Error("the model is down");
        return { type: "question_detected", isQuestion: false };
      },
    });
  }

  async function inbox() {
    return (await getAll(
      `SELECT status, attempts, last_error, handed_off_at FROM message_inbox
         WHERE channel_account_id = ? ORDER BY id`,
      [tenant.channelAccountId],
    )) as Array<{
      status: string;
      attempts: number;
      last_error: string | null;
      handed_off_at: number | null;
    }>;
  }

  async function conversation() {
    return (await getOne(
      `SELECT status, handover_reason FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [tenant.tenantId, tenant.channelAccountId, CUSTOMER],
    )) as {
      status: string;
      handover_reason: string | null;
    };
  }

  const ref = () => tenant.ref(CUSTOMER);
  const stub = () => conversationStub(ref());

  async function wake(): Promise<void> {
    await stub().wake(ref());
  }

  /** Queues a message past its quiet window, as the webhook would have. */
  async function queue(id: string, body: string): Promise<void> {
    await storeIncomingMessage(ref(), {
      id,
      from: CUSTOMER,
      body,
      type: "text",
      timestamp: Math.floor(Date.now() / 1000) - 660,
    });
    await run(
      "UPDATE message_inbox SET created_at = created_at - 60000 WHERE message_id = ?",
      [id],
    );
  }

  async function outboundRows(): Promise<number> {
    return (
      (await getOne(
        `SELECT COUNT(*) AS n FROM messages
           WHERE channel_account_id = ? AND direction = 'outbound'`,
        [tenant.channelAccountId],
      )) as { n: number }
    ).n;
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("turn-recovery");
    // A number that genuinely sends, so a reply reaches the fake network.
    await run("DELETE FROM channel_accounts WHERE id = ?", [
      tenant.channelAccountId,
    ]);
    const account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: tenant.phoneNumberId,
      accessToken: "EAAG-a-real-looking-token",
    });
    tenant.channelAccountId = account.id;

    await insertConversation(
      {
        tenantId: tenant.tenantId,
        channelAccountId: account.id,
        phoneNumber: CUSTOMER,
      },
      {
        contextData: {
          phase: OBJECTION,
          metadata: { createdAt: Date.now(), lastActivityAt: Date.now() },
        },
      },
    );

    delivered = [];
    alerts = [];
    attempts = 0;
    failures = 0;
    whileAnswering = {};
    replyStep();
    eventBus.on("escalation_triggered", onAlert);

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.type === "text") delivered.push(body.text.body);
      return new Response(
        JSON.stringify({ messages: [{ id: `wamid-out-${delivered.length}` }] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    eventBus.off("escalation_triggered", onAlert);
    enrichmentRegistry.clear();
    globalThis.fetch = originalFetch;
  });

  it("is answered once when the reply step throws once and then works", async () => {
    failures = 1;
    await customerWrites(tenant, CUSTOMER, "mmm lo voy a pensar");
    expect(delivered).toEqual([]);
    expect(await inbox()).toMatchObject([{ status: "pending", attempts: 1 }]);

    await wake();
    await wake();

    expect(delivered).toEqual([FOLLOW_UP]);
    expect(await inbox()).toMatchObject([{ status: "processed", attempts: 1 }]);
    expect((await conversation()).status).toBe("active");
    expect(alerts).toEqual([]);
  });

  it("is handed to a person with a reason when the reply step always throws", async () => {
    failures = Infinity;
    await customerWrites(tenant, CUSTOMER, "mmm lo voy a pensar");
    await wake();
    // Nothing is left to try, so a third pass finds no ready row.
    await wake();

    expect(attempts).toBe(2);
    expect(await inbox()).toMatchObject([
      { status: "failed", attempts: 2, last_error: "the model is down" },
    ]);
    expect(delivered).toEqual([]);
    expect(await conversation()).toEqual({
      status: "human_takeover",
      handover_reason: "turn_failed",
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({
      reason: "turn_failed",
      context: { failedTurns: 1, lastReason: "the model is down" },
    });
    expect((await inbox())[0]!.handed_off_at).not.toBeNull();

    // The handoff is by state, so a later pass does not alert again.
    await wake();
    expect(alerts).toHaveLength(1);
  });

  it("hands off a message that joined after the first failure, with the older one", async () => {
    failures = Infinity;
    await customerWrites(tenant, CUSTOMER, "mmm lo voy a pensar");
    expect(await inbox()).toMatchObject([{ status: "pending", attempts: 1 }]);

    await customerWrites(tenant, CUSTOMER, "¿y si lo dejo para después?");

    expect(attempts).toBe(2);
    expect(await inbox()).toMatchObject([
      { status: "failed", attempts: 2 },
      { status: "failed", attempts: 2 },
    ]);
    expect((await conversation()).handover_reason).toBe("turn_failed");
    expect(alerts).toHaveLength(1);
    expect((await inbox()).every((row) => row.handed_off_at !== null)).toBe(
      true,
    );
    // Nothing is left pending for a silent answer after the handoff.
    await wake();
    expect(attempts).toBe(2);
    expect(delivered).toEqual([]);
  });

  it("hands off a message that arrives while the last attempt runs", async () => {
    failures = Infinity;
    // The webhook's own wake would wait for the lock this turn holds, so the
    // message is queued as the webhook queues it.
    whileAnswering[2] = () =>
      queue("wamid-late", "¿y si lo dejo para después?");
    await customerWrites(tenant, CUSTOMER, "mmm lo voy a pensar");
    await wake();

    expect(attempts).toBe(2);
    expect(await inbox()).toMatchObject([
      { status: "failed", attempts: 2 },
      { status: "failed", attempts: 2 },
    ]);
    expect(alerts).toHaveLength(1);
    expect((await inbox()).every((row) => row.handed_off_at !== null)).toBe(
      true,
    );
    await wake();
    expect(attempts).toBe(2);
    expect(delivered).toEqual([]);
  });

  it("hands off a message that arrived while an ended object ran its last attempt", async () => {
    failures = Infinity;
    await queue("wamid-first", "mmm lo voy a pensar");
    await run(
      `UPDATE message_inbox SET status = 'processing', attempts = 1
       WHERE channel_account_id = ?`,
      [tenant.channelAccountId],
    );
    await queue("wamid-second", "¿y si lo dejo para después?");

    await wake();

    expect(await inbox()).toMatchObject([
      { status: "failed", attempts: 2 },
      { status: "failed", attempts: 2 },
    ]);
    expect(alerts).toHaveLength(1);
    expect(attempts).toBe(0);
  });

  it("fails together the rows an ended object left with different attempts", async () => {
    failures = Infinity;
    await queue("wamid-first", "mmm lo voy a pensar");
    await queue("wamid-second", "¿y si lo dejo para después?");
    await run(
      `UPDATE message_inbox SET status = 'processing', attempts = id % 2
       WHERE channel_account_id = ?`,
      [tenant.channelAccountId],
    );
    expect((await inbox()).map((row) => row.attempts).sort()).toEqual([0, 1]);

    await wake();

    expect(await inbox()).toMatchObject([
      { status: "failed", attempts: 2 },
      { status: "failed", attempts: 2 },
    ]);
  });

  it("settles the rows a turn leaves when recording its failure throws too", async () => {
    failures = Infinity;
    // A trigger that refuses an attempts write stands in for a D1 error in
    // `recordFailedTurn`, after the group was already marked `processing`.
    whileAnswering[1] = async () => {
      await run(
        `CREATE TRIGGER refuse_attempt_writes BEFORE UPDATE ON message_inbox
         WHEN NEW.attempts <> OLD.attempts
         BEGIN SELECT RAISE(ABORT, 'd1 gone'); END`,
      );
    };
    await queue("wamid-first", "mmm lo voy a pensar");

    await expect(wake()).rejects.toThrow();
    expect(await inbox()).toMatchObject([{ status: "processing" }]);

    // The next wake settles the leftover rows instead of leaving them
    // `processing` in a live object: the dead write counts as one attempt,
    // the retry fails on its own, and the handoff covers the rows.
    await run("DROP TRIGGER refuse_attempt_writes");
    await wake();

    expect(attempts).toBe(2);
    expect(await inbox()).toMatchObject([
      { status: "failed", attempts: 2, last_error: "the model is down" },
    ]);
    expect(await conversation()).toEqual({
      status: "human_takeover",
      handover_reason: "turn_failed",
    });
    expect(alerts).toHaveLength(1);
  });

  it("is answered after its object is aborted mid-turn, with no duplicate send", async () => {
    let state!: DurableObjectState;
    await runInDurableObject(stub(), (_object, objectState) => {
      state = objectState;
    });
    whileAnswering[1] = async () => {
      state.abort("killed mid-turn");
    };

    await expect(
      customerWrites(tenant, CUSTOMER, "mmm lo voy a pensar"),
    ).rejects.toThrow();
    expect(await inbox()).toMatchObject([
      { status: "processing", attempts: 0 },
    ]);
    expect(delivered).toEqual([]);

    // The next instance settles the dead turn, then answers it.
    await wake();

    expect(delivered).toEqual([FOLLOW_UP]);
    expect(await outboundRows()).toBe(1);
    expect(await inbox()).toMatchObject([{ status: "processed", attempts: 1 }]);
    expect(alerts).toEqual([]);
  });
});
