/**
 * A person's takeover stops the bot, and releasing the conversation hands it
 * back. Every test runs the real path: the webhook stores the inbound message,
 * the conversation's object answers it, and the only fakes are the network and
 * the model.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { Hono } from "hono";

import { getAll, getOne, run } from "./helpers/db.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import {
  deliver,
  whileLocked,
  customerWrites as writeIn,
} from "./helpers/turn.ts";

import type { ConversationRef } from "@vendeya/types";

import { ConversationBusyError } from "../src/conversation/locks.ts";
import type { ConversationObject } from "../src/conversation/object.ts";
import { conversationStub } from "../src/conversation/stub.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import {
  releaseConversation,
  sendManualMessage,
  takeoverConversation,
} from "../src/domains/conversations/write.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import conversationRoutes from "../src/routes/conversations.ts";
import {
  DEFAULT_REPLY,
  type FakeModel,
  fakeModel,
  withOpenAiKey,
} from "./helpers/model.ts";

const CUSTOMER = "51900555001";
const HOUR = 60 * 60 * 1000;
const TAKEOVER_REASON = "Manual takeover by agent";
const BOT_REASON = "asked_for_a_person";

describe("a person takes over a conversation", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let agent: string;
  let originalFetch: typeof globalThis.fetch;
  /** Text messages that reached the network. Read receipts are not counted. */
  let textSends: string[];
  /** Runs before the network answers. A test holds a bot turn here. */
  let beforeNetworkAnswers: () => Promise<void>;
  let model: FakeModel;

  async function insert(
    options: {
      status?: string;
      handoverReason?: string | null;
      lastActivityAt?: number;
    } = {},
  ): Promise<void> {
    await insertConversation(ref, { status: options.status });
    await run(
      `UPDATE conversations SET handover_reason = ?, last_activity_at = ?
       WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [
        options.handoverReason ?? null,
        options.lastActivityAt ?? Date.now(),
        ref.tenantId,
        ref.channelAccountId,
        ref.phoneNumber,
      ],
    );
  }

  async function conversation() {
    const row = (await getOne(
      `SELECT status, handover_reason, last_activity_at, assigned_agent
         FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    )) as {
      status: string;
      handover_reason: string | null;
      last_activity_at: number;
      assigned_agent: string | null;
    };
    return {
      status: row.status,
      handoverReason: row.handover_reason,
      lastActivityAt: row.last_activity_at,
      assignedAgent: row.assigned_agent,
    };
  }

  async function setLastActivity(at: number): Promise<void> {
    await run(
      `UPDATE conversations SET last_activity_at = ?
       WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [at, ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    );
  }

  async function rawRow() {
    return await getOne(
      `SELECT * FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    );
  }

  async function customerWrites(text: string): Promise<void> {
    await writeIn(tenant, CUSTOMER, text);
  }

  /** The customer writes in and the quiet window passes, with the turn not yet run. */
  async function customerWritesAndWaits(text: string): Promise<void> {
    expect((await deliver(tenant.phoneNumberId, CUSTOMER, text)).status).toBe(
      200,
    );
    await run(
      `UPDATE message_inbox SET created_at = created_at - 60000
       WHERE channel_account_id = ? AND status = 'pending'`,
      [tenant.channelAccountId],
    );
  }

  /**
   * Runs `fn` inside the conversation's object. A test that holds a turn at
   * the network makes its promises here, because the object may await only
   * promises it made.
   */
  function insideObject(
    fn: (object: ConversationObject) => Promise<void>,
  ): Promise<void> {
    return runInDurableObject(conversationStub(ref), fn);
  }

  /** Holds the turn's first send at the network until `release` is called. */
  function holdFirstSend(): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedNetwork!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedNetwork = resolve;
    });
    let turnHeld = false;
    beforeNetworkAnswers = async () => {
      if (turnHeld) return;
      turnHeld = true;
      reachedNetwork();
      await held;
    };
    return { reached, release };
  }

  async function inboxStatuses(): Promise<string[]> {
    return (
      (await getAll(
        "SELECT status FROM message_inbox WHERE channel_account_id = ? ORDER BY id",
        [tenant.channelAccountId],
      )) as Array<{ status: string }>
    ).map((row) => row.status);
  }

  async function storedInbound(): Promise<string[]> {
    return (await MessageStore.getHistory(ref, 100))
      .filter((m) => m.direction === "inbound")
      .map((m) => m.content);
  }

  async function auditActions(): Promise<string[]> {
    return (
      (await getAll(
        "SELECT action FROM audit_log WHERE tenant_id = ? ORDER BY rowid",
        [tenant.tenantId],
      )) as Array<{ action: string }>
    ).map((row) => row.action);
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("takeover");
    // A number that genuinely sends, so a bot reply reaches the fake network.
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
    agent = (await createMember(tenant, "sales_agent")).userId;

    textSends = [];
    beforeNetworkAnswers = async () => {};
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      await beforeNetworkAnswers();
      if (body.type === "text") textSends.push(body.text.body);
      return new Response(
        JSON.stringify({ messages: [{ id: `wamid-out-${textSends.length}` }] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    model = fakeModel();
    await withOpenAiKey(tenant.tenantId);
  });

  afterEach(async () => {
    model.restore();
    globalThis.fetch = originalFetch;
    await run("DELETE FROM audit_log WHERE user_id = ?", [agent]);
  });

  describe("while the bot is answering", () => {
    it("keeps the bot silent on the next message and still stores it", async () => {
      await insert();

      await takeoverConversation(ref, agent);
      await customerWrites("quiero el segundo");

      expect(textSends).toEqual([]);
      expect(await storedInbound()).toEqual(["quiero el segundo"]);
      expect(await inboxStatuses()).toEqual(["processed"]);

      const after = await conversation();
      expect(after.status).toBe("human_takeover");
      expect(after.handoverReason).toBe(TAKEOVER_REASON);
    });

    it("waits for a bot turn in flight and leaves the conversation held", async () => {
      await insert();
      await customerWritesAndWaits("hola");

      await insideObject(async (object) => {
        const send = holdFirstSend();
        const turn = object.wake(ref);
        await send.reached;

        let takeoverDone = false;
        const takeover = takeoverConversation(ref, agent).then(() => {
          takeoverDone = true;
        });
        await scheduler.wait(50);

        expect(takeoverDone).toBe(false);
        expect((await conversation()).status).toBe("active");

        send.release();
        await Promise.all([turn, takeover]);
      });

      const after = await conversation();
      expect(after.status).toBe("human_takeover");
      expect(after.handoverReason).toBe(TAKEOVER_REASON);
    });

    it("refreshes the activity time, and so does an agent's reply", async () => {
      const stale = Date.now() - 2 * HOUR;
      await insert({ lastActivityAt: stale });

      const beforeTakeover = Date.now();
      await takeoverConversation(ref, agent);
      expect((await conversation()).lastActivityAt).toBeGreaterThanOrEqual(
        beforeTakeover,
      );

      await setLastActivity(stale);

      const beforeReply = Date.now();
      const result = await sendManualMessage(ref, "Hola, soy Ana", agent);

      expect(result).toEqual({ success: true });
      expect(textSends).toEqual(["Hola, soy Ana"]);
      const after = await conversation();
      expect(after.lastActivityAt).toBeGreaterThanOrEqual(beforeReply);
      expect(after.status).toBe("human_takeover");
    });

    it("does not refresh the activity time when nothing was sent", async () => {
      const stale = Date.now() - 2 * HOUR;
      await insert({ lastActivityAt: stale });

      const result = await sendManualMessage(ref, "", agent);

      expect(result.success).toBe(false);
      expect((await conversation()).lastActivityAt).toBe(stale);
    });
  });

  describe("when an agent replies", () => {
    it("leaves the status alone while a bot turn is in flight", async () => {
      await insert({ lastActivityAt: Date.now() - 2 * HOUR });

      await customerWritesAndWaits("hola");

      let during!: Awaited<ReturnType<typeof conversation>>;
      let result!: Awaited<ReturnType<typeof sendManualMessage>>;
      let beforeReply!: number;
      await insideObject(async (object) => {
        const send = holdFirstSend();
        const turn = object.wake(ref);
        await send.reached;

        beforeReply = Date.now();
        result = await sendManualMessage(ref, "Hola, soy Ana", agent);
        during = await conversation();
        send.release();
        await turn;
      });

      expect(result).toEqual({ success: true });
      expect(textSends).toContain("Hola, soy Ana");
      expect(during.status).toBe("active");
      expect(during.handoverReason).toBeNull();
      expect(during.lastActivityAt).toBeGreaterThanOrEqual(beforeReply);
      expect((await conversation()).status).toBe("active");
    });

    it("refreshes only the activity time", async () => {
      await insert({ lastActivityAt: Date.now() - 2 * HOUR });
      const before = (await rawRow()) as Record<string, unknown>;

      await sendManualMessage(ref, "Hola, soy Ana", agent);

      const after = (await rawRow()) as Record<string, unknown>;
      expect(after.last_activity_at as number).toBeGreaterThan(
        before.last_activity_at as number,
      );
      expect({ ...after, last_activity_at: 0 }).toEqual({
        ...before,
        last_activity_at: 0,
      });
    });
  });

  describe("when the person hands the conversation back", () => {
    async function expectBotAnswersAgain(): Promise<void> {
      const released = await conversation();
      expect(released.status).toBe("active");
      expect(released.handoverReason).toBeNull();

      await customerWrites("hola");

      expect(textSends.length).toBeGreaterThan(0);
      expect(await inboxStatuses()).toEqual(["processed"]);
      expect((await conversation()).status).toBe("active");
    }

    it("after a takeover, the bot answers the next message", async () => {
      await insert();

      await takeoverConversation(ref, agent);
      await releaseConversation(ref, agent);

      await expectBotAnswersAgain();
    });

    it("after the bot handed it off, the bot answers the next message", async () => {
      await insert({ status: "human_takeover", handoverReason: BOT_REASON });

      await releaseConversation(ref, agent);

      await expectBotAnswersAgain();
    });

    it("no longer assigns the agent who released it", async () => {
      await insert();

      await takeoverConversation(ref, agent);
      expect((await conversation()).assignedAgent).toBe(agent);
      await releaseConversation(ref, agent);

      expect((await conversation()).assignedAgent).toBeNull();
    });

    it("no longer assigns the agent when the hold goes idle", async () => {
      await insert();
      await takeoverConversation(ref, agent);
      await setLastActivity(Date.now() - 4 * HOUR);

      await customerWrites("hola");

      expect(await conversation()).toMatchObject({
        status: "active",
        assignedAgent: null,
      });
    });

    it("keeps the agent of a conversation the bot owns when it goes idle", async () => {
      await insert({ lastActivityAt: Date.now() - 4 * HOUR });
      await run(
        `UPDATE conversations SET assigned_agent = ?
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [agent, ref.tenantId, ref.channelAccountId, ref.phoneNumber],
      );

      await customerWrites("hola");

      expect((await conversation()).assignedAgent).toBe(agent);
    });
  });

  describe("when the person releases a conversation the bot already owns", () => {
    async function botOwned(): Promise<void> {
      await insert({ lastActivityAt: Date.now() - HOUR });
    }

    it("changes nothing and answers success", async () => {
      await botOwned();
      const before = await rawRow();

      const result = await releaseConversation(ref, agent);

      expect(result).toEqual({ success: true });
      expect(await rawRow()).toEqual(before);
      expect(await auditActions()).toEqual([]);
    });

    it("answers success over HTTP and changes nothing", async () => {
      await botOwned();
      const before = await rawRow();
      const app = new Hono();
      app.onError(errorHandler);
      app.use("/api/*", requireAuth);
      app.route("/api/conversations", conversationRoutes);
      const token = generateSessionToken();
      await createSession(token, agent, tenant.tenantId);

      const response = await app.request(
        `/api/conversations/${CUSTOMER}/release`,
        { method: "POST", headers: { Cookie: `session=${token}` } },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(await rawRow()).toEqual(before);
      expect(await auditActions()).toEqual([]);
    });

    it("does not restart a conversation a second release reaches", async () => {
      await insert();
      await takeoverConversation(ref, agent);

      await Promise.all([
        releaseConversation(ref, agent),
        releaseConversation(ref, agent),
      ]);

      expect(await auditActions()).toEqual(["takeover", "release"]);
    });

    it("leaves what the first release started alone when a second arrives later", async () => {
      await insert();
      await takeoverConversation(ref, agent);
      await releaseConversation(ref, agent);

      await customerWrites("hola");
      const answered = await rawRow();
      expect(textSends).toEqual([DEFAULT_REPLY]);

      await releaseConversation(ref, agent);

      expect(await rawRow()).toEqual(answered);
      expect(await auditActions()).toEqual(["takeover", "release"]);
    });

    it("moves a held conversation with no agent back to the bot", async () => {
      await insert({ status: "human_takeover" });

      await releaseConversation(ref, agent);

      expect((await conversation()).status).toBe("active");
      expect(await auditActions()).toEqual(["release"]);
    });
  });

  describe("when the conversation lock does not come free", () => {
    it("refuses a takeover and changes nothing", async () => {
      await insert();
      const before = await rawRow();

      await whileLocked(ref, () =>
        expect(takeoverConversation(ref, agent)).rejects.toThrow(
          ConversationBusyError,
        ),
      );

      expect(await rawRow()).toEqual(before);
      expect(await auditActions()).toEqual([]);
    });

    it("refuses a release and changes nothing", async () => {
      await insert({
        status: "human_takeover",
        handoverReason: TAKEOVER_REASON,
      });
      const before = await rawRow();

      await whileLocked(ref, () =>
        expect(releaseConversation(ref, agent)).rejects.toThrow(
          ConversationBusyError,
        ),
      );

      expect(await rawRow()).toEqual(before);
      expect(await auditActions()).toEqual([]);
    });

    describe("through the HTTP routes", () => {
      let app: Hono;
      let cookie: string;

      beforeEach(async () => {
        app = new Hono();
        app.onError(errorHandler);
        app.use("/api/*", requireAuth);
        app.route("/api/conversations", conversationRoutes);

        const token = generateSessionToken();
        await createSession(token, agent, tenant.tenantId);
        cookie = `session=${token}`;
      });

      function post(action: "takeover" | "release") {
        return app.request(`/api/conversations/${CUSTOMER}/${action}`, {
          method: "POST",
          headers: { Cookie: cookie },
        });
      }

      for (const action of ["takeover", "release"] as const) {
        it(`answers ${action} with an error the dashboard can show`, async () => {
          await insert();
          const before = await rawRow();

          const response = await whileLocked(ref, async () => post(action));

          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({
            error: "The conversation is busy. Try again in a moment.",
          });
          expect(await rawRow()).toEqual(before);
          expect(await auditActions()).toEqual([]);
        });
      }

      it("writes one audit row for each of takeover and release", async () => {
        await insert();

        expect((await post("takeover")).status).toBe(200);
        expect((await post("release")).status).toBe(200);

        expect(await auditActions()).toEqual(["takeover", "release"]);
      });
    });
  });

  describe("an idle hold", () => {
    it("goes back to the bot when the customer writes", async () => {
      await insert({
        status: "human_takeover",
        handoverReason: BOT_REASON,
        lastActivityAt: Date.now() - 4 * HOUR,
      });

      await customerWrites("hola");

      expect(textSends.length).toBeGreaterThan(0);
      const after = await conversation();
      expect(after.status).toBe("active");
      expect(after.handoverReason).toBeNull();
    });

    it("does not change a conversation the bot was answering", async () => {
      await insert({ lastActivityAt: Date.now() - 4 * HOUR });

      await customerWrites("hola");

      expect(textSends).toEqual([DEFAULT_REPLY]);
      expect((await conversation()).status).toBe("active");
    });

    it("stays with the agent who answered it recently", async () => {
      await insert({ lastActivityAt: Date.now() - 4 * HOUR });
      await takeoverConversation(ref, agent);
      await sendManualMessage(ref, "Hola, soy Ana", agent);
      textSends.length = 0;

      await customerWrites("gracias");

      expect(textSends).toEqual([]);
      expect((await conversation()).status).toBe("human_takeover");
    });
  });
});
