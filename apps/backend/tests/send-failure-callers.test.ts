/**
 * A send that WhatsApp did not accept must not be reported as one that went
 * out. An agent's manual reply acts on the outcome.
 * The only fake is the network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

import { getAll, getOne, run } from "./helpers/db.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import type { ConversationRef } from "@vendeya/types";

import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { raiseUnreadAlert } from "../src/conversation/unread-alerts.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import conversationRoutes from "../src/routes/conversations.ts";

const CUSTOMER = "51900888001";

describe("a send WhatsApp did not accept", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let agent: string;
  let originalFetch: typeof globalThis.fetch;
  /** Request bodies that reached the network, in order. */
  let requests: Array<Record<string, any>>;
  /** Decides the answer to one request. */
  let answer: (body: Record<string, any>) => Response;

  const accepted = () =>
    new Response(
      JSON.stringify({ messages: [{ id: `wamid-${crypto.randomUUID()}` }] }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  const refused = () =>
    new Response(JSON.stringify({ error: { code: 131047 } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  const refusesEverything = () => refused();

  function textRequests() {
    return requests.filter((r) => r.type === "text");
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("send-failure");
    const account = await ChannelAccountService.create({
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
    await insertConversation(ref);
    agent = (await createMember(tenant, "sales_agent")).userId;

    requests = [];
    answer = () => accepted();
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push(body);
      return answer(body);
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
  });

  describe("when an agent sends a manual reply", () => {
    const STALE = 1_000_000;
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

      await run(
        `UPDATE conversations SET last_activity_at = ?
         WHERE tenant_id = ? AND phone_number = ?`,
        [STALE, ref.tenantId, ref.phoneNumber],
      );
      await raiseUnreadAlert(ref);
    });

    function reply(content = "Hola, soy Ana") {
      return app.request(`/api/conversations/${CUSTOMER}/message`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
    }

    async function audit() {
      return (
        (await getAll(
          `SELECT user_id, action, resource_type, resource_id, metadata
             FROM audit_log WHERE tenant_id = ? ORDER BY rowid`,
          [tenant.tenantId],
        )) as Array<{
          user_id: string;
          action: string;
          resource_type: string;
          resource_id: string;
          metadata: string;
        }>
      ).map((row) => ({ ...row, metadata: JSON.parse(row.metadata) }));
    }

    async function lastActivityAt(): Promise<number> {
      return (
        (await getOne(
          `SELECT last_activity_at FROM conversations
             WHERE tenant_id = ? AND phone_number = ?`,
          [ref.tenantId, ref.phoneNumber],
        )) as { last_activity_at: number }
      ).last_activity_at;
    }

    async function unreadAlerts(): Promise<number> {
      return (
        (await getOne(
          "SELECT COUNT(*) AS n FROM unread_alerts WHERE tenant_id = ?",
          [ref.tenantId],
        )) as { n: number }
      ).n;
    }

    const failures = {
      permanent: {
        answer: refusesEverything,
        error:
          "The message could not be sent, so the customer did not receive it",
      },
      transient: {
        answer: () => new Response("{}", { status: 503 }),
        error:
          "WhatsApp is not accepting messages right now, so the customer did not receive it. Try again in a moment",
      },
    };

    it("answers success and audits the reply when it went out", async () => {
      const response = await reply();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(textRequests()).toHaveLength(1);
      expect(await audit()).toEqual([
        {
          user_id: agent,
          action: "send_message",
          resource_type: "conversation",
          resource_id: CUSTOMER,
          metadata: { message: "Hola, soy Ana" },
        },
      ]);
      expect(await lastActivityAt()).toBeGreaterThan(STALE);
      expect(await unreadAlerts()).toBe(0);
    });

    for (const [kind, failure] of Object.entries(failures)) {
      it(`answers a failure and writes no audit row when WhatsApp refuses the reply (${kind})`, async () => {
        answer = failure.answer;

        const response = await reply();

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: failure.error });
        expect(await audit()).toEqual([]);
        expect(await lastActivityAt()).toBe(STALE);
        expect(await unreadAlerts()).toBe(1);
        expect((await MessageStore.getHistory(ref))[0]).toMatchObject({
          status: "failed",
        });
      });
    }

    const unconfirmedError =
      "WhatsApp did not confirm the message, so it may not have reached the customer";

    for (const [cause, fail] of [
      [
        "an answer without a message id",
        () => (answer = () => new Response("{}")),
      ],
      [
        "a connection that drops mid-send",
        () => {
          globalThis.fetch = (async () => {
            throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
          }) as unknown as typeof globalThis.fetch;
        },
      ],
    ] as const) {
      it(`answers a failure, audits the reply as unconfirmed and moves nothing else on ${cause}`, async () => {
        fail();

        const response = await reply();

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: unconfirmedError });
        expect(await audit()).toEqual([
          {
            user_id: agent,
            action: "send_message",
            resource_type: "conversation",
            resource_id: CUSTOMER,
            metadata: { message: "Hola, soy Ana", deliveryUnconfirmed: true },
          },
        ]);
        expect(await lastActivityAt()).toBe(STALE);
        expect(await unreadAlerts()).toBe(1);
      });
    }
  });
});
