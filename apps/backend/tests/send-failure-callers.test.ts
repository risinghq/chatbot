/**
 * A send that WhatsApp did not accept must not be reported as one that went
 * out. The bundle images, the phase the executor persists and an agent's manual
 * reply each act on the outcome. The only fake is the network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

import { getAll, getOne, run } from "../src/db/index.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import type { ConversationMetadata, ConversationPhase } from "@vendeya/core";
import type { ConversationRef } from "@vendeya/types";

import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { executeCommands } from "../src/conversation/handler/command-executor.ts";
import { sendBundleImages } from "../src/conversation/images.ts";
import { BundleService } from "../src/domains/catalog/bundles.ts";
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
const IMAGE_CHEAP = "img-cheap";
const IMAGE_DEAR = "img-dear";

const OFFERING: ConversationPhase = {
  phase: "offering_products",
  segment: "fnb",
  credit: 5000,
  name: "Juan",
};

describe("a send WhatsApp did not accept", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let agent: string;
  let cheapId: string;
  let dearId: string;
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
  const refusesImage = (imageId: string) => (body: Record<string, any>) =>
    body.type === "image" && body.image.link.includes(imageId)
      ? refused()
      : accepted();
  const refusesEverything = () => refused();

  function imageRequests() {
    return requests.filter((r) => r.type === "image");
  }
  function textRequests() {
    return requests.filter((r) => r.type === "text");
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

  async function createBundle(
    name: string,
    price: number,
    imageId: string,
  ): Promise<string> {
    const id = `bundle-${crypto.randomUUID()}`;
    await BundleService.create({
      id,
      tenantId: tenant.tenantId,
      period_id: periodId,
      segment: "fnb",
      name,
      price,
      primary_category: "cocinas",
      categories_json: JSON.stringify(["cocinas"]),
      image_id: imageId,
      composition_json: JSON.stringify({ fixed: [], choices: [] }),
      installments_json: JSON.stringify([{ months: 12, monthlyAmount: 110 }]),
      created_by: null,
    });
    return id;
  }

  let periodId: string;

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

    periodId = `per-${crypto.randomUUID()}`;
    await run(
      `INSERT INTO catalog_periods (id, tenant_id, name, year_month, status)
       VALUES (?, ?, 'Enero', '2026-01', 'active')`,
      [periodId, tenant.tenantId],
    );
    cheapId = await createBundle("Cocina 2 hornillas", 800, IMAGE_CHEAP);
    dearId = await createBundle("Cocina 4 hornillas", 1200, IMAGE_DEAR);

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

  describe("when the bundle images are sent", () => {
    const params = () => ({
      ref,
      segment: "fnb" as const,
      creditLine: 5000,
      isSimulation: false,
    });

    it("reports success and both products when every image is accepted", async () => {
      const result = await sendBundleImages(params());

      expect(result.success).toBe(true);
      expect(result.products.map((p) => p.productId)).toEqual([
        cheapId,
        dearId,
      ]);
      expect(textRequests()).toHaveLength(1);
    });

    it("reports no success, no products and no follow-up when every image is refused", async () => {
      answer = refusesEverything;

      const result = await sendBundleImages(params());

      expect(result).toEqual({ success: false, products: [] });
      expect(imageRequests()).toHaveLength(2);
      expect(textRequests()).toHaveLength(0);
    });

    it("returns only the accepted product, at its original position, when one is refused", async () => {
      answer = refusesImage(IMAGE_CHEAP);

      const result = await sendBundleImages(params());

      expect(result.success).toBe(true);
      expect(result.products).toEqual([
        {
          name: "Cocina 4 hornillas",
          position: 2,
          productId: dearId,
          price: 1200,
        },
      ]);
      expect(textRequests()).toHaveLength(1);
    });

    it("still reports every product for a simulated conversation", async () => {
      const result = await sendBundleImages({
        ...params(),
        isSimulation: true,
      });

      expect(result.success).toBe(true);
      expect(result.products).toHaveLength(2);
      expect(requests).toHaveLength(0);
    });
  });

  describe("when the executor records what the customer was shown", () => {
    const metadata = {
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    } as ConversationMetadata;

    const images = {
      type: "update" as const,
      nextPhase: OFFERING,
      commands: [{ type: "SEND_IMAGES" as const, category: "cocinas" }],
    };
    const bundle = () => ({
      type: "update" as const,
      nextPhase: OFFERING,
      commands: [{ type: "SEND_BUNDLE" as const, bundleId: dearId }],
    });

    it("records sentProducts for an accepted category image", async () => {
      await executeCommands(images, ref, metadata, false, "trace");

      expect(await storedPhase()).toMatchObject({
        phase: "offering_products",
        sentProducts: [{ productId: cheapId }, { productId: dearId }],
      });
    });

    it("records no sentProducts when every category image is refused", async () => {
      answer = refusesEverything;

      await executeCommands(images, ref, metadata, false, "trace");

      const phase = await storedPhase();
      expect(phase.phase).toBe("offering_products");
      expect(phase).not.toHaveProperty("sentProducts");
      expect(phase).not.toHaveProperty("lastAction");
    });

    it("records only the accepted products when one category image is refused", async () => {
      answer = refusesImage(IMAGE_CHEAP);

      await executeCommands(images, ref, metadata, false, "trace");

      expect(await storedPhase()).toMatchObject({
        sentProducts: [{ productId: dearId, position: 2 }],
        lastAction: { type: "showed_products", productCount: 1 },
      });
    });

    it("records sentProducts for an accepted single bundle", async () => {
      await executeCommands(bundle(), ref, metadata, false, "trace");

      expect(await storedPhase()).toMatchObject({
        sentProducts: [{ productId: dearId, position: 1 }],
      });
    });

    it("records no sentProducts when the single bundle image is refused", async () => {
      answer = refusesEverything;

      await executeCommands(bundle(), ref, metadata, false, "trace");

      const phase = await storedPhase();
      expect(phase.phase).toBe("offering_products");
      expect(phase).not.toHaveProperty("sentProducts");
      expect(phase).not.toHaveProperty("lastAction");
    });

    it("persists the phase after a text send that failed, and does not throw", async () => {
      answer = refusesEverything;

      await executeCommands(
        {
          type: "update",
          nextPhase: OFFERING,
          commands: [{ type: "SEND_MESSAGE", text: "hola" }],
        },
        ref,
        metadata,
        false,
        "trace",
      );

      expect((await storedPhase()).phase).toBe("offering_products");
      expect((await MessageStore.getHistory(ref))[0]).toMatchObject({
        status: "failed",
      });
    });
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
