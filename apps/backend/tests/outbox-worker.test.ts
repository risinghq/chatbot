/**
 * The conversation's object sends its queued replies, one at a time and in the
 * order the bot produced them, until each goes out or its budget runs out. Each
 * test wakes the object at a clock it sets, so no test waits on a timer, and
 * the only fake is the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAll, getOne, run } from "../src/db/index.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
  setChannelStatus,
} from "./helpers/tenancy.ts";

import type { ConversationMetadata, ConversationPhase } from "@vendeya/core";
import type { ConversationMessage, ConversationRef } from "@vendeya/types";

import { executeCommands } from "../src/conversation/handler/command-executor.ts";
import { CloudApiAdapter } from "../src/adapters/whatsapp/cloud-api.ts";
import { WhatsAppService } from "../src/adapters/whatsapp/index.ts";
import {
  claimRow,
  MAX_AGE_MS,
  OUTBOX_RETENTION_MS,
  purgeFinishedOutbox,
  type OutboxRow,
} from "../src/conversation/outbox.ts";
import { conversationStub } from "../src/conversation/stub.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { takeoverConversation } from "../src/domains/conversations/write.ts";
import { wakeAt } from "./helpers/turn.ts";
import { runInDurableObject } from "cloudflare:test";
import type { ConversationObject } from "../src/conversation/object.ts";

const CUSTOMER = "51900999001";

/** How much real time a pass may take before a delay assertion is suspicious. */
const SLACK_MS = 2_000;

/** How long a held send takes, which every delay it schedules must clear. */
const HELD_SEND_MS = 300;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("the outbox sender", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let agent: string;
  let originalFetch: typeof globalThis.fetch;
  /** Text bodies that reached the network, in order. */
  let textSends: string[];
  /** Every send request body that reached the network, accepted or not. */
  let requests: Array<Record<string, any>>;
  let answer: () => Response;
  /** Runs before the network answers. A test holds a send here. */
  let beforeNetworkAnswers: () => Promise<void>;

  const accepted = () =>
    new Response(
      JSON.stringify({ messages: [{ id: `wamid-${textSends.length}` }] }),
      { headers: { "Content-Type": "application/json" } },
    );
  /** A 502 with an HTML body: the adapter classifies it `transient`. */
  const unreachable = () =>
    new Response("<html>Bad gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
  /** A reset connection: the adapter classifies it `ambiguous`. */
  const reset = (): Response => {
    throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  };

  async function rows(): Promise<OutboxRow[]> {
    return (await getAll(
      `SELECT * FROM outbox
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
         ORDER BY id`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    )) as OutboxRow[];
  }

  /**
   * A retry delay runs from the end of the attempt, so the stored time is the
   * delay plus however long the pass really took.
   */
  function expectDelay(
    nextAttemptAt: number,
    countedFrom: number,
    delay: number,
  ): void {
    expect(nextAttemptAt).toBeGreaterThanOrEqual(countedFrom + delay);
    expect(nextAttemptAt).toBeLessThan(countedFrom + delay + SLACK_MS);
  }

  async function message(id: string): Promise<ConversationMessage> {
    return (await getOne("SELECT * FROM messages WHERE id = ?", [
      id,
    ])) as ConversationMessage;
  }

  /** Queue one reply by letting its inline send fail the way `answer` says. */
  async function queue(text: string): Promise<OutboxRow> {
    const before = (await rows()).length;
    await WhatsAppService.sendMessage(ref, text, { retry: true });
    const queued = await rows();
    expect(queued).toHaveLength(before + 1);
    return queued[before]!;
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("outbox-worker");
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

    textSends = [];
    requests = [];
    answer = accepted;
    beforeNetworkAnswers = async () => {};
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push(body);
      await beforeNetworkAnswers();
      const response = answer();
      if (response.ok && body.type === "text") textSends.push(body.text.body);
      return response;
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    await run("DELETE FROM audit_log WHERE user_id = ?", [agent]);
  });

  it("sends a due row and puts Meta's id on the message it already wrote", async () => {
    answer = unreachable;
    const row = await queue("hola");
    const queuedAt = (await message(row.message_id)).created_at;
    answer = accepted;

    await wakeAt(ref, row.next_attempt_at);

    expect(textSends).toEqual(["hola"]);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      status: "sent",
      attempts: 2,
      last_kind: "accepted",
      last_reason: null,
    });
    expect(await message(row.message_id)).toMatchObject({
      status: "sent",
      whatsapp_message_id: "wamid-0",
      // A late reply keeps its place in the thread.
      created_at: queuedAt,
    });
  });

  it("leaves a row alone before it is due", async () => {
    answer = unreachable;
    const row = await queue("hola");
    answer = accepted;

    // The pass's clock runs on from the wake, so the wake comes well before.
    await wakeAt(ref, row.next_attempt_at - SLACK_MS);

    expect(textSends).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("retries a transient failure at 5 s, 30 s, 2 min and 10 min, then gives up", async () => {
    answer = unreachable;
    const row = await queue("hola");

    const schedule = [5_000, 30_000, 2 * 60_000, 10 * 60_000];
    let attemptEndedAt = row.created_at;

    for (const [index, delay] of schedule.entries()) {
      const waiting = (await rows())[0]!;
      expect(waiting).toMatchObject({
        status: "pending",
        attempts: index + 1,
      });
      expectDelay(waiting.next_attempt_at, attemptEndedAt, delay);

      attemptEndedAt = waiting.next_attempt_at;
      await wakeAt(ref, waiting.next_attempt_at);
    }

    expect((await rows())[0]).toMatchObject({
      status: "failed",
      attempts: 5,
      last_kind: "transient",
      last_reason: "exhausted",
    });
    expect((await message(row.message_id)).status).toBe("failed");
  });

  it("retries an ambiguous send once and then gives up, rather than risk a third delivery", async () => {
    answer = reset;
    const row = await queue("hola");

    expect((await rows())[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      ambiguous_attempts: 1,
      next_attempt_at: row.created_at + 5_000,
    });

    await wakeAt(ref, row.created_at + 5_000);

    expect((await rows())[0]).toMatchObject({
      status: "failed",
      attempts: 2,
      ambiguous_attempts: 2,
      last_kind: "ambiguous",
      last_reason: "network:ECONNRESET",
    });
    expect((await message(row.message_id)).status).toBe("failed");
  });

  it("holds the rows behind the head, then sends them in order after it", async () => {
    answer = unreachable;
    const first = await queue("primero");
    await queue("segundo");
    answer = accepted;

    // The second row is due from the moment it was queued, and stays put.
    await wakeAt(ref, first.created_at + 1_000);
    expect(textSends).toEqual([]);
    expect((await rows()).map((row) => row.status)).toEqual([
      "pending",
      "pending",
    ]);

    // Once the head goes out, the rows behind it follow in the same pass.
    await wakeAt(ref, first.next_attempt_at);
    expect(textSends).toEqual(["primero", "segundo"]);

    expect((await rows()).map((row) => row.status)).toEqual(["sent", "sent"]);
  });

  it("gives up on a row an hour old without asking WhatsApp again", async () => {
    answer = unreachable;
    const row = await queue("hola");
    answer = accepted;

    await wakeAt(ref, row.created_at + MAX_AGE_MS);

    expect(textSends).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      last_reason: "expired",
    });
    expect((await message(row.message_id)).status).toBe("failed");
  });

  it("expires a row of a number that stays switched off", async () => {
    answer = unreachable;
    const row = await queue("hola");
    await setChannelStatus(ref.channelAccountId, "disabled");
    answer = accepted;

    await wakeAt(ref, row.next_attempt_at);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 1 });

    await wakeAt(ref, row.created_at + MAX_AGE_MS);

    expect(textSends).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      last_reason: "expired",
    });
  });

  it("sends nothing for a suspended tenant and leaves the row pending", async () => {
    answer = unreachable;
    const row = await queue("hola");
    await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
      tenant.tenantId,
    ]);
    answer = accepted;

    await wakeAt(ref, row.next_attempt_at);
    await wakeAt(ref, row.created_at + MAX_AGE_MS);

    expect(textSends).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 1 });

    await run("UPDATE tenants SET status = 'active' WHERE id = ?", [
      tenant.tenantId,
    ]);
  });

  it("counts no attempt when the number is switched off before the row is due", async () => {
    answer = unreachable;
    const row = await queue("hola");
    answer = accepted;

    await setChannelStatus(ref.channelAccountId, "disabled");
    await wakeAt(ref, row.next_attempt_at);

    expect(textSends).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 1 });
    expectDelay(
      (await rows())[0]!.next_attempt_at,
      row.next_attempt_at,
      60_000,
    );
    expect((await message(row.message_id)).status).toBe("queued");
  });

  it("records a row an ended object left sending as one ambiguous attempt", async () => {
    answer = unreachable;
    const row = await queue("hola");
    await run("UPDATE outbox SET status = 'sending' WHERE id = ?", [row.id]);

    await conversationStub(ref).wake(ref);

    expect((await rows())[0]).toMatchObject({
      status: "pending",
      attempts: 2,
      ambiguous_attempts: 1,
      last_kind: "ambiguous",
      last_reason: "interrupted",
    });
    expect((await message(row.message_id)).status).toBe("queued");
  });

  it("sends a row only once when two passes both found it due", async () => {
    answer = unreachable;
    const row = await queue("hola");
    requests.length = 0;

    // Both wakes come while the row is due. The second waits for the lock and
    // must find the row rescheduled and leave it. The held send's promises are
    // made inside the object, which may await only its own.
    vi.setSystemTime(row.next_attempt_at);
    await runInDurableObject(
      conversationStub(ref),
      async (object: ConversationObject) => {
        let releaseFirstSend!: () => void;
        const held = new Promise<void>((resolve) => {
          releaseFirstSend = resolve;
        });
        let firstSendReached!: () => void;
        const reached = new Promise<void>((resolve) => {
          firstSendReached = resolve;
        });
        let sendsReached = 0;
        beforeNetworkAnswers = async () => {
          sendsReached++;
          if (sendsReached === 1) {
            firstSendReached();
            await held;
          }
        };

        const passes = Promise.all([object.wake(ref), object.wake(ref)]);
        await reached;
        releaseFirstSend();
        await passes;
      },
    );

    expect(requests).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 2 });
    expectDelay(
      (await rows())[0]!.next_attempt_at,
      row.next_attempt_at,
      30_000,
    );
  });

  it("counts a transient retry from the end of a slow attempt, not the start of the pass", async () => {
    answer = unreachable;
    const row = await queue("hola");
    beforeNetworkAnswers = () => sleep(HELD_SEND_MS);

    await wakeAt(ref, row.next_attempt_at);

    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 2 });
    expect((await rows())[0]!.next_attempt_at).toBeGreaterThanOrEqual(
      row.next_attempt_at + HELD_SEND_MS + 30_000,
    );
  });

  it("keeps the whole 5 s after a slow ambiguous attempt, so the next poll does not resend at once", async () => {
    answer = unreachable;
    const row = await queue("hola");
    answer = reset;
    beforeNetworkAnswers = () => sleep(HELD_SEND_MS);

    const pollStartedAt = row.next_attempt_at;
    await wakeAt(ref, pollStartedAt);

    expect((await rows())[0]).toMatchObject({
      status: "pending",
      ambiguous_attempts: 1,
      last_reason: "network:ECONNRESET",
    });
    // An ambiguous send may already be on its way to the customer. The spacing
    // that keeps a duplicate apart is gone if the row is due the moment the
    // attempt ends.
    expect((await rows())[0]!.next_attempt_at).toBeGreaterThan(
      pollStartedAt + 5_000,
    );
    expect((await rows())[0]!.next_attempt_at).toBeGreaterThanOrEqual(
      pollStartedAt + HELD_SEND_MS + 5_000,
    );
  });

  it("sends a queued image again with the caption it was queued with", async () => {
    answer = unreachable;
    await WhatsAppService.sendImage(
      ref,
      "images/img-dear.jpg",
      "Cocina 4 hornillas\nPrecio: S/ 1200.00",
      "bundle-1",
      { retry: true },
    );
    const row = (await rows())[0]!;
    requests.length = 0;
    answer = accepted;

    await wakeAt(ref, row.next_attempt_at);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      type: "image",
      image: { caption: "Cocina 4 hornillas\nPrecio: S/ 1200.00" },
    });
    expect((await rows())[0]!.status).toBe("sent");
  });

  it("treats a send that threw as ambiguous, so it is repeated at most once", async () => {
    answer = unreachable;
    const row = await queue("hola");

    const realSend = CloudApiAdapter.sendMessage;
    CloudApiAdapter.sendMessage = () => {
      throw new Error("the adapter itself broke");
    };
    try {
      await wakeAt(ref, row.next_attempt_at);

      expect((await rows())[0]).toMatchObject({
        status: "pending",
        attempts: 2,
        ambiguous_attempts: 1,
        last_kind: "ambiguous",
        last_reason: "send_threw",
      });
      expectDelay(
        (await rows())[0]!.next_attempt_at,
        row.next_attempt_at,
        5_000,
      );

      await wakeAt(ref, (await rows())[0]!.next_attempt_at);

      expect((await rows())[0]).toMatchObject({
        status: "failed",
        attempts: 3,
        ambiguous_attempts: 2,
        last_reason: "send_threw",
      });
    } finally {
      CloudApiAdapter.sendMessage = realSend;
    }
    expect((await message((await rows())[0]!.message_id)).status).toBe(
      "failed",
    );
  });

  it("refuses to claim a row that is no longer pending, and changes nothing", async () => {
    answer = unreachable;
    const row = await queue("hola");
    await takeoverConversation(ref, agent);
    const cancelled = (await rows())[0]!;

    // `row` is the stale copy a pass read before the takeover landed.
    expect(await claimRow(row, Date.now())).toBeUndefined();

    expect((await rows())[0]).toEqual(cancelled);
  });

  describe("when a person takes the conversation over", () => {
    it("cancels the replies the bot still owed, and the worker sends none of them", async () => {
      answer = unreachable;
      const first = await queue("primero");
      await queue("segundo");
      answer = accepted;

      await takeoverConversation(ref, agent);

      expect((await rows()).map((row) => row.status)).toEqual([
        "cancelled",
        "cancelled",
      ]);
      expect(
        await Promise.all(
          (await rows()).map(
            async (row) => (await message(row.message_id)).status,
          ),
        ),
      ).toEqual(["cancelled", "cancelled"]);

      await wakeAt(ref, first.next_attempt_at);

      expect(textSends).toEqual([]);
    });

    it("records how many replies it dropped on the audit row", async () => {
      answer = unreachable;
      await queue("primero");
      await queue("segundo");

      await takeoverConversation(ref, agent);

      const audit = (await getOne(
        "SELECT metadata FROM audit_log WHERE tenant_id = ? AND action = 'takeover'",
        [tenant.tenantId],
      )) as { metadata: string };
      expect(JSON.parse(audit.metadata)).toEqual({ cancelledReplies: 2 });
    });

    it("leaves a row the worker already sent alone", async () => {
      answer = unreachable;
      const row = await queue("hola");
      answer = accepted;
      await wakeAt(ref, row.next_attempt_at);

      await takeoverConversation(ref, agent);

      expect((await rows())[0]!.status).toBe("sent");
      expect((await message(row.message_id)).status).toBe("sent");
    });
  });

  describe("the retention purge", () => {
    it("deletes rows a week after they finished, and keeps the rest", async () => {
      answer = unreachable;
      const stale = await queue("viejo");
      const waiting = await queue("nuevo");
      await run(
        "UPDATE outbox SET status = 'failed', updated_at = ? WHERE id = ?",
        [Date.now() - OUTBOX_RETENTION_MS - 1, stale.id],
      );

      expect(await purgeFinishedOutbox()).toBe(1);

      expect((await rows()).map((row) => row.id)).toEqual([waiting.id]);
    });

    it("keeps a row that finished inside the window", async () => {
      answer = unreachable;
      const row = await queue("hola");
      await run(
        "UPDATE outbox SET status = 'sent', updated_at = ? WHERE id = ?",
        [Date.now() - OUTBOX_RETENTION_MS + 60_000, row.id],
      );

      expect(await purgeFinishedOutbox()).toBe(0);
      expect(await rows()).toHaveLength(1);
    });
  });

  describe("when the bot escalates", () => {
    const metadata = {
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    } as ConversationMetadata;

    const escalating = {
      type: "update" as const,
      nextPhase: {
        phase: "escalated",
        reason: "multiple_objections",
      } as ConversationPhase,
      commands: [
        {
          type: "SEND_MESSAGE" as const,
          text: "Un asesor te contactará en breve",
        },
      ],
    };

    it("keeps the advisor message queued, because nobody took the conversation over", async () => {
      answer = unreachable;

      await executeCommands(escalating, ref, metadata, false, "trace");

      const queued = await rows();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        status: "pending",
        content: "Un asesor te contactará en breve",
      });

      answer = accepted;
      await wakeAt(ref, queued[0]!.next_attempt_at);

      expect(textSends).toEqual(["Un asesor te contactará en breve"]);
      expect((await rows())[0]!.status).toBe("sent");
    });
  });
});
