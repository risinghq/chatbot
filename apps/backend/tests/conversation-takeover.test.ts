/**
 * A person's takeover stops the bot, and releasing the conversation hands it
 * back. Every test runs the real path: the webhook stores the inbound message,
 * the conversation's object answers it, and the only fake is the network.

 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { Hono } from "hono";

import { getAll, getOne, run } from "../src/db/index.ts";
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

import type { ConversationPhase } from "@vendeya/core";
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

const CUSTOMER = "51900555001";
const HOUR = 60 * 60 * 1000;

const OFFERING: ConversationPhase = {
  phase: "offering_products",
  segment: "fnb",
  credit: 5000,
  name: "Juan",
};

describe("a person takes over a conversation", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let agent: string;
  let originalFetch: typeof globalThis.fetch;
  /** Text messages that reached the network. Read receipts are not counted. */
  let textSends: string[];
  /** Runs before the network answers. A test holds a bot turn here. */
  let beforeNetworkAnswers: () => Promise<void>;

  async function insert(
    phase: ConversationPhase,
    options: {
      status?: string;
      handoverReason?: string | null;
      lastActivityAt?: number;
      metadata?: Record<string, unknown>;
      columns?: { client_name?: string; dni?: string; credit_line?: number };
    } = {},
  ): Promise<void> {
    const now = Date.now();
    await insertConversation(ref, {
      status: options.status,
      contextData: {
        phase,
        metadata: {
          createdAt: now,
          lastActivityAt: options.lastActivityAt ?? now,
          ...options.metadata,
        },
      },
    });
    await run(
      `UPDATE conversations
       SET handover_reason = ?, client_name = ?, dni = ?, credit_line = ?
       WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [
        options.handoverReason ?? null,
        options.columns?.client_name ?? null,
        options.columns?.dni ?? null,
        options.columns?.credit_line ?? null,
        ref.tenantId,
        ref.channelAccountId,
        ref.phoneNumber,
      ],
    );
  }

  async function conversation() {
    const row = (await getOne(
      `SELECT status, handover_reason, context_data, client_name, dni, credit_line
         FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    )) as {
      status: string;
      handover_reason: string | null;
      context_data: string;
      client_name: string | null;
      dni: string | null;
      credit_line: number | null;
    };
    const context = JSON.parse(row.context_data);
    return {
      status: row.status,
      handoverReason: row.handover_reason,
      phase: context.phase as ConversationPhase,
      metadata: context.metadata as Record<string, unknown>,
      columns: {
        client_name: row.client_name,
        dni: row.dni,
        credit_line: row.credit_line,
      },
    };
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
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await run("DELETE FROM audit_log WHERE user_id = ?", [agent]);
  });

  describe("while the bot is answering", () => {
    it("keeps the bot silent on the next message and still stores it", async () => {
      await insert(OFFERING);

      await takeoverConversation(ref, agent);
      await customerWrites("quiero el segundo");

      expect(textSends).toEqual([]);
      expect(await storedInbound()).toEqual(["quiero el segundo"]);
      expect(await inboxStatuses()).toEqual(["processed"]);

      const after = await conversation();
      expect(after.phase.phase).toBe("escalated");
      expect(after.status).toBe("human_takeover");
      expect(after.handoverReason).toBe("Manual takeover by agent");
    });

    it("waits for a bot turn in flight and leaves the conversation escalated", async () => {
      await insert({ phase: "greeting" });
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
      expect(after.phase.phase).toBe("escalated");
      expect(after.status).toBe("human_takeover");
      expect(after.handoverReason).toBe("Manual takeover by agent");
    });

    it("keeps the customer's name, DNI and credit line", async () => {
      await insert(OFFERING, {
        metadata: { name: "Juan", dni: "12345678", credit: 5000 },
        columns: { client_name: "Juan", dni: "12345678", credit_line: 5000 },
      });

      await takeoverConversation(ref, agent);

      const after = await conversation();
      expect(after.metadata).toMatchObject({
        name: "Juan",
        dni: "12345678",
        credit: 5000,
      });
      expect(after.columns).toEqual({
        client_name: "Juan",
        dni: "12345678",
        credit_line: 5000,
      });
    });

    it("refreshes the activity time, and so does an agent's reply", async () => {
      const stale = Date.now() - 2 * HOUR;
      await insert(OFFERING, { lastActivityAt: stale });

      const beforeTakeover = Date.now();
      await takeoverConversation(ref, agent);
      const takenAt = (await conversation()).metadata.lastActivityAt as number;
      expect(takenAt).toBeGreaterThanOrEqual(beforeTakeover);

      await run(
        `UPDATE conversations
         SET context_data = json_set(context_data, '$.metadata.lastActivityAt', ?)
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [stale, ref.tenantId, ref.channelAccountId, ref.phoneNumber],
      );

      const beforeReply = Date.now();
      const result = await sendManualMessage(ref, "Hola, soy Ana", agent);

      expect(result).toEqual({ success: true });
      expect(textSends).toEqual(["Hola, soy Ana"]);
      const after = await conversation();
      expect(after.metadata.lastActivityAt as number).toBeGreaterThanOrEqual(
        beforeReply,
      );
      expect(after.phase.phase).toBe("escalated");
    });

    it("does not refresh the activity time when nothing was sent", async () => {
      const stale = Date.now() - 2 * HOUR;
      await insert(OFFERING, { lastActivityAt: stale });

      const result = await sendManualMessage(ref, "", agent);

      expect(result.success).toBe(false);
      expect((await conversation()).metadata.lastActivityAt).toBe(stale);
    });
  });

  describe("when an agent replies", () => {
    async function rawRow() {
      return await getOne(
        `SELECT * FROM conversations
           WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
      );
    }

    async function setContextData(value: string | null): Promise<void> {
      await run(
        `UPDATE conversations SET context_data = ?
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [value, ref.tenantId, ref.channelAccountId, ref.phoneNumber],
      );
    }

    it("leaves the phase and status alone while a bot turn is in flight", async () => {
      // An escalated phase with an active status. Writing this phase back
      // would set the status to human_takeover.
      await insert(
        { phase: "escalated", reason: "multiple_objections" },
        { status: "active", lastActivityAt: Date.now() - 2 * HOUR },
      );

      await customerWritesAndWaits("hola");

      let before!: Awaited<ReturnType<typeof conversation>>;
      let during!: Awaited<ReturnType<typeof conversation>>;
      let result!: Awaited<ReturnType<typeof sendManualMessage>>;
      let beforeReply!: number;
      await insideObject(async (object) => {
        const send = holdFirstSend();
        const turn = object.wake(ref);
        await send.reached;
        before = await conversation();

        beforeReply = Date.now();
        result = await sendManualMessage(ref, "Hola, soy Ana", agent);
        during = await conversation();
        send.release();
        await turn;
      });

      expect(result).toEqual({ success: true });

      expect(textSends).toEqual(["Hola, soy Ana"]);
      expect(during.phase).toEqual(before.phase);
      expect(during.status).toBe("active");
      expect(during.handoverReason).toBeNull();
      expect(during.metadata.lastActivityAt as number).toBeGreaterThanOrEqual(
        beforeReply,
      );
      expect((await conversation()).status).toBe("active");
    });

    it("refreshes only the activity time", async () => {
      await insert(OFFERING, {
        lastActivityAt: Date.now() - 2 * HOUR,
        metadata: { name: "Juan", dni: "12345678" },
        columns: { client_name: "Juan", dni: "12345678", credit_line: 5000 },
      });
      const before = await conversation();

      await sendManualMessage(ref, "Hola, soy Ana", agent);

      const after = await conversation();
      expect(after.metadata.lastActivityAt as number).toBeGreaterThan(
        before.metadata.lastActivityAt as number,
      );
      expect({
        ...after,
        metadata: { ...after.metadata, lastActivityAt: 0 },
      }).toEqual({
        ...before,
        metadata: { ...before.metadata, lastActivityAt: 0 },
      });
    });

    it("leaves a conversation with no context data as it was", async () => {
      await insert(OFFERING);
      await setContextData(null);
      const before = await rawRow();

      const result = await sendManualMessage(ref, "Hola, soy Ana", agent);

      expect(result).toEqual({ success: true });
      expect(textSends).toEqual(["Hola, soy Ana"]);
      expect(await rawRow()).toEqual(before);
    });

    it("does not write a phase into context data that has none", async () => {
      await insert(OFFERING);
      await setContextData("{}");

      await sendManualMessage(ref, "Hola, soy Ana", agent);

      const stored = JSON.parse(
        ((await rawRow()) as { context_data: string }).context_data,
      );
      expect(stored.phase).toBeUndefined();
    });
  });

  describe("when the person hands the conversation back", () => {
    async function expectBotAnswersAgain(): Promise<void> {
      const released = await conversation();
      expect(released.status).toBe("active");
      expect(released.handoverReason).toBeNull();
      expect(released.phase).toEqual({ phase: "greeting" });

      await customerWrites("hola");

      expect(textSends.length).toBeGreaterThan(0);
      expect(await inboxStatuses()).toEqual(["processed"]);
      expect((await conversation()).phase.phase).not.toBe("escalated");
    }

    it("after a takeover, the bot answers the next message", async () => {
      await insert(OFFERING);

      await takeoverConversation(ref, agent);
      await releaseConversation(ref, agent);

      await expectBotAnswersAgain();
    });

    it("after the bot escalated, the bot answers the next message", async () => {
      await insert(
        { phase: "escalated", reason: "multiple_objections" },
        { status: "human_takeover", handoverReason: "multiple_objections" },
      );

      await releaseConversation(ref, agent);

      await expectBotAnswersAgain();
    });

    async function assignedAgent(): Promise<string | null> {
      return (
        (await getOne(
          `SELECT assigned_agent FROM conversations
             WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
          [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
        )) as {
          assigned_agent: string | null;
        }
      ).assigned_agent;
    }

    it("no longer assigns the agent who released it", async () => {
      await insert(OFFERING);

      await takeoverConversation(ref, agent);
      expect(await assignedAgent()).toBe(agent);
      await releaseConversation(ref, agent);

      expect(await assignedAgent()).toBeNull();
    });

    it("no longer assigns the agent when the session times out", async () => {
      await insert(OFFERING);
      await takeoverConversation(ref, agent);
      await run(
        `UPDATE conversations
         SET context_data = json_set(context_data, '$.metadata.lastActivityAt', ?)
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [
          Date.now() - 4 * HOUR,
          ref.tenantId,
          ref.channelAccountId,
          ref.phoneNumber,
        ],
      );

      await customerWrites("hola");

      expect((await conversation()).status).toBe("active");
      expect(await assignedAgent()).toBeNull();
    });

    it("keeps the agent of a conversation the bot owns when the session times out", async () => {
      await insert(OFFERING, { lastActivityAt: Date.now() - 4 * HOUR });
      await run(
        `UPDATE conversations SET assigned_agent = ?
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [agent, ref.tenantId, ref.channelAccountId, ref.phoneNumber],
      );

      await customerWrites("hola");

      expect(await assignedAgent()).toBe(agent);
    });

    it("starts over with the customer as a returning user", async () => {
      await insert(OFFERING, {
        metadata: { lastCategory: "cocinas", name: "Juan", dni: "12345678" },
      });

      await takeoverConversation(ref, agent);
      await releaseConversation(ref, agent);

      expect((await conversation()).metadata).toMatchObject({
        isReturningUser: true,
        lastCategory: "cocinas",
      });
      expect((await conversation()).metadata.dni).toBeUndefined();
    });
  });

  describe("when the person releases a conversation the bot already owns", () => {
    async function rawRow() {
      return await getOne(
        `SELECT * FROM conversations
           WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
      );
    }

    async function botOwned(): Promise<void> {
      await insert(OFFERING, {
        lastActivityAt: Date.now() - HOUR,
        metadata: { name: "Juan", dni: "12345678", lastCategory: "cocinas" },
        columns: { client_name: "Juan", dni: "12345678", credit_line: 5000 },
      });
    }

    it("changes nothing and answers success", async () => {
      await botOwned();
      const before = { row: await rawRow(), state: await conversation() };

      const result = await releaseConversation(ref, agent);

      expect(result).toEqual({ success: true });
      expect(await rawRow()).toEqual(before.row);
      expect(await conversation()).toEqual(before.state);
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
      await insert(OFFERING);
      await takeoverConversation(ref, agent);

      await Promise.all([
        releaseConversation(ref, agent),
        releaseConversation(ref, agent),
      ]);

      expect(await auditActions()).toEqual(["takeover", "release"]);
    });

    it("leaves what the first release started alone when a second arrives later", async () => {
      await insert(OFFERING);
      await takeoverConversation(ref, agent);
      await releaseConversation(ref, agent);

      await customerWrites("hola");
      const answered = await conversation();
      expect(answered.phase.phase).toBe("confirming_client");

      await releaseConversation(ref, agent);

      expect(await conversation()).toEqual(answered);
      expect(await auditActions()).toEqual(["takeover", "release"]);
    });

    it("still moves a conversation that only has the human_takeover status", async () => {
      await insert(OFFERING, { status: "human_takeover" });

      await releaseConversation(ref, agent);

      const after = await conversation();
      expect(after.status).toBe("active");
      expect(after.phase).toEqual({ phase: "greeting" });
      expect(await auditActions()).toEqual(["release"]);
    });

    it("still moves a conversation that only has the escalated phase", async () => {
      await insert({ phase: "escalated", reason: "multiple_objections" });

      await releaseConversation(ref, agent);

      const after = await conversation();
      expect(after.status).toBe("active");
      expect(after.phase).toEqual({ phase: "greeting" });
      expect(await auditActions()).toEqual(["release"]);
    });
  });

  describe("when the conversation lock does not come free", () => {
    it("refuses a takeover and changes nothing", async () => {
      await insert(OFFERING);
      const before = await conversation();

      await whileLocked(ref, () =>
        expect(takeoverConversation(ref, agent)).rejects.toThrow(
          ConversationBusyError,
        ),
      );

      expect(await conversation()).toEqual(before);
      expect(await auditActions()).toEqual([]);
    });

    it("refuses a release and changes nothing", async () => {
      await insert(
        { phase: "escalated", reason: "Manual takeover by agent" },
        {
          status: "human_takeover",
          handoverReason: "Manual takeover by agent",
        },
      );
      const before = await conversation();

      await whileLocked(ref, () =>
        expect(releaseConversation(ref, agent)).rejects.toThrow(
          ConversationBusyError,
        ),
      );

      expect(await conversation()).toEqual(before);
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
          await insert(OFFERING);
          const before = await conversation();

          const response = await whileLocked(ref, async () => post(action));

          expect(response.status).toBe(409);
          expect(await response.json()).toEqual({
            error: "The conversation is busy. Try again in a moment.",
          });
          expect(await conversation()).toEqual(before);
          expect(await auditActions()).toEqual([]);
        });
      }

      it("writes one audit row for each of takeover and release", async () => {
        await insert(OFFERING);

        expect((await post("takeover")).status).toBe(200);
        expect((await post("release")).status).toBe(200);

        expect(await auditActions()).toEqual(["takeover", "release"]);
      });
    });
  });

  describe("the idle reset", () => {
    it("still hands an escalated conversation back to the bot", async () => {
      await insert(
        { phase: "escalated", reason: "multiple_objections" },
        {
          status: "human_takeover",
          handoverReason: "multiple_objections",
          lastActivityAt: Date.now() - 4 * HOUR,
        },
      );

      await customerWrites("hola");

      expect(textSends.length).toBeGreaterThan(0);
      const after = await conversation();
      expect(after.status).toBe("active");
      expect(after.handoverReason).toBeNull();
      expect(after.phase.phase).not.toBe("escalated");
    });

    it("restarts an idle conversation the bot was answering", async () => {
      await insert(OFFERING, { lastActivityAt: Date.now() - 4 * HOUR });

      await customerWrites("hola");

      expect(textSends.length).toBeGreaterThan(0);
      expect((await conversation()).phase.phase).toBe("confirming_client");
    });

    it("leaves a conversation an agent answered recently with the agent", async () => {
      await insert(OFFERING, { lastActivityAt: Date.now() - 4 * HOUR });
      await takeoverConversation(ref, agent);
      await sendManualMessage(ref, "Hola, soy Ana", agent);
      textSends.length = 0;

      await customerWrites("gracias");

      expect(textSends).toEqual([]);
      expect((await conversation()).phase.phase).toBe("escalated");
    });
  });
});
