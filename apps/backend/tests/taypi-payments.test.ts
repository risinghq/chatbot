/**
 * A business connects its own TAYPI keys, and an order's balance becomes a
 * pay link: a TAYPI checkout session the customer pays on a public page.
 * The payment is confirmed on the order once, by the signed webhook or by
 * the page's status check, whichever arrives first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { OrderDetail, Product, ProductVariant } from "@vendeya/types";

import { publicOrigin } from "../src/config.ts";
import { db } from "./helpers/db.ts";
import {
  runTool,
  toolsFor,
  type ToolContext,
} from "../src/domains/assistant/tools/index.ts";
import {
  TaypiCharges,
  TAYPI_METHOD_NAME,
} from "../src/domains/payments/charges.ts";
import {
  parseTaypiKeys,
  saveTaypiKeys,
  taypiKeys,
  taypiSignatureMatches,
  type TaypiKeys,
} from "../src/domains/payments/taypi.ts";
import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import admin from "../src/routes/admin.ts";
import catalogRoutes from "../src/routes/catalog.ts";
import orderRoutes from "../src/routes/orders.ts";
import pay from "../src/routes/pay.ts";
import stockRoutes from "../src/routes/stock.ts";
import taypiWebhook from "../src/routes/taypi-webhook.ts";
import { createMember, createTenantFixture } from "./helpers/tenancy.ts";

const app = new Hono();
app.route("/api/webhook/taypi", taypiWebhook);
app.route("/api/pay", pay);
app.use("/api/*", requireAuth);
app.route("/api/catalog", catalogRoutes);
app.route("/api/orders", orderRoutes);
app.route("/api/stock", stockRoutes);
app.use("/api/admin/*", requireRole("admin"));
app.route("/api/admin", admin);
app.onError(errorHandler);

const KEYS: TaypiKeys = {
  publicKey: `taypi_pk_test_${"a".repeat(32)}`,
  secretKey: `taypi_sk_test_${"b".repeat(64)}`,
  webhookSecret: "whsec_test_0123456789abcdef",
};

const FORM = {
  public_key: KEYS.publicKey,
  secret_key: KEYS.secretKey,
  webhook_secret: KEYS.webhookSecret,
};

type Sent = { method: string; url: URL; headers: Headers; body: string };

/**
 * TAYPI's sandbox: it opens sessions, names the merchant, and lists the
 * payments `paid` holds for a reference.
 */
function fakeTaypi(
  sent: Sent[],
  paid: Map<string, object[]>,
  merchantStatus = 200,
) {
  return vi.fn(async (input: any, init?: any) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    sent.push({
      method: request.method,
      url,
      headers: request.headers,
      body: await request.text(),
    });
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/api/v1/merchant") {
      return merchantStatus === 200
        ? reply(200, {
            data: { business_name: "Polos SAC", webhook_url: null },
          })
        : reply(merchantStatus, {
            error: "INVALID_API_KEY",
            message: "bad key",
          });
    }
    if (url.pathname === "/v1/checkout/sessions") {
      return reply(201, {
        data: { checkout_token: `tok_${sent.length}` },
      });
    }
    if (url.pathname === "/api/v1/payments") {
      return reply(200, {
        data: paid.get(url.searchParams.get("reference") ?? "") ?? [],
      });
    }
    return reply(404, { error: "NOT_FOUND", message: url.pathname });
  }) as any;
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

describe("TAYPI keys", () => {
  it("parse only a public and a secret key from the same environment", () => {
    expect(parseTaypiKeys(FORM)).toEqual(KEYS);
    expect(
      parseTaypiKeys({
        ...FORM,
        secret_key: `taypi_sk_live_${"b".repeat(64)}`,
      }),
    ).toMatch(/mismo entorno/);
    expect(parseTaypiKeys({ ...FORM, public_key: "pk_123" })).toMatch(
      /taypi_pk_test_/,
    );
    expect(parseTaypiKeys({ ...FORM, webhook_secret: "short" })).toMatch(
      /webhook/,
    );
  });

  it("verify a webhook body against its sha256 signature", async () => {
    const body = '{"event":"payment.completed"}';
    const good = `sha256=${await hmac(KEYS.webhookSecret, body)}`;
    expect(await taypiSignatureMatches(body, good, KEYS.webhookSecret)).toBe(
      true,
    );
    expect(
      await taypiSignatureMatches(`${body} `, good, KEYS.webhookSecret),
    ).toBe(false);
    expect(await taypiSignatureMatches(body, null, KEYS.webhookSecret)).toBe(
      false,
    );
  });
});

describe("a TAYPI pay link", () => {
  const originalFetch = globalThis.fetch;
  let sent: Sent[];
  let paid: Map<string, object[]>;
  let tenantId: string;
  let channelAccountId: string;
  let call: (method: string, path: string, body?: unknown) => Promise<Response>;
  let variant: ProductVariant;

  async function takeOrder(quantity = 2): Promise<OrderDetail> {
    return await json<OrderDetail>(
      await call("POST", "/api/orders", {
        customer: { name: "Ana Torres", phone: "51987654321" },
        lines: [{ variant_id: variant.id, quantity }],
      }),
      201,
    );
  }

  async function orderOf(id: string): Promise<OrderDetail> {
    return await json<OrderDetail>(await call("GET", `/api/orders/${id}`), 200);
  }

  async function signedEvent(body: object, secret = KEYS.webhookSecret) {
    const raw = JSON.stringify(body);
    return await app.request(`/api/webhook/taypi/${tenantId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "taypi-signature": `sha256=${await hmac(secret, raw)}`,
      },
      body: raw,
    });
  }

  beforeEach(async () => {
    sent = [];
    paid = new Map();
    globalThis.fetch = fakeTaypi(sent, paid);
    ({ tenantId, channelAccountId } = await createTenantFixture("taypi"));
    const { userId } = await createMember({ tenantId }, "admin");
    const token = generateSessionToken();
    await createSession(token, userId, tenantId);
    call = async (method, path, body) =>
      await app.request(path, {
        method,
        headers: {
          Cookie: `session=${token}`,
          "X-Tenant-Id": tenantId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const product = await json<Product>(
      await call("POST", "/api/catalog/products", {
        name: "Polo básico",
        category: "ropa",
      }),
      200,
    );
    variant = await json<ProductVariant>(
      await call("POST", `/api/catalog/products/${product.id}/variants`, {
        name: "M",
        sku: `POLO-${crypto.randomUUID().slice(0, 8)}`,
        price_cents: 4990,
      }),
      201,
    );
    await json(
      await call("POST", "/api/stock/movements", {
        variant_id: variant.id,
        kind: "receive",
        quantity: 50,
      }),
      201,
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("connecting", () => {
    it("stores keys TAYPI accepts and shows the webhook URL to paste", async () => {
      const saved = await json<Record<string, unknown>>(
        await call("PUT", "/api/admin/taypi", FORM),
        200,
      );
      expect(saved).toMatchObject({
        connected: true,
        environment: "sandbox",
        business_name: "Polos SAC",
        webhook_url: `${publicOrigin()}/api/webhook/taypi/${tenantId}`,
      });
      expect(await taypiKeys(tenantId)).toEqual(KEYS);
      const shown = await json<Record<string, unknown>>(
        await call("GET", "/api/admin/taypi"),
        200,
      );
      expect(shown).toMatchObject({ connected: true, environment: "sandbox" });
      expect(JSON.stringify(shown)).not.toContain(KEYS.secretKey);
    });

    it("refuses keys TAYPI rejects and stores nothing", async () => {
      globalThis.fetch = fakeTaypi(sent, paid, 401);
      const refused = await json<{ reason: string }>(
        await call("PUT", "/api/admin/taypi", FORM),
        400,
      );
      expect(refused.reason).toBe("taypi_rejected_keys");
      expect(await taypiKeys(tenantId)).toBeNull();
    });

    it("forgets the keys on disconnect", async () => {
      await saveTaypiKeys(tenantId, KEYS);
      expect((await call("DELETE", "/api/admin/taypi")).status).toBe(204);
      expect(await taypiKeys(tenantId)).toBeNull();
    });

    it("never takes TAYPI keys through the plaintext settings form", async () => {
      const result = await json<{ rejected: string[] }>(
        await call("POST", "/api/admin/settings", {
          taypi_secret_key: KEYS.secretKey,
        }),
        200,
      );
      expect(result.rejected).toEqual(["taypi_secret_key"]);
      const row = await db
        .selectFrom("tenant_settings")
        .select("key")
        .where("tenant_id", "=", tenantId)
        .where("key", "=", "taypi_secret_key")
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });
  });

  describe("for staff", () => {
    it("asks the business to connect TAYPI first", async () => {
      const order = await takeOrder();
      const refused = await json<{ reason: string }>(
        await call("POST", `/api/orders/${order.id}/taypi-link`),
        400,
      );
      expect(refused.reason).toBe("not_connected");
      expect(sent).toHaveLength(0);
    });

    it("opens a signed checkout session for the balance and reuses it", async () => {
      await saveTaypiKeys(tenantId, KEYS);
      const order = await takeOrder();

      const link = await json<{ url: string; amount_cents: number }>(
        await call("POST", `/api/orders/${order.id}/taypi-link`),
        201,
      );
      expect(link.amount_cents).toBe(9980);
      expect(link.url).toMatch(new RegExp(`^${publicOrigin()}/pagar/[\\w-]+$`));

      const [session] = sent;
      expect(session?.url.origin).toBe("https://sandbox.taypi.pe");
      const body = JSON.parse(session!.body);
      expect(body).toMatchObject({ amount: "99.80", expires_in: 60 });
      expect(body.description).toContain(`Pedido #${order.number}`);
      const ts = session!.headers.get("taypi-timestamp")!;
      expect(session!.headers.get("taypi-signature")).toBe(
        await hmac(
          KEYS.secretKey,
          `${ts}\nPOST\n/v1/checkout/sessions\n${session!.body}`,
        ),
      );
      expect(session!.headers.get("idempotency-key")).toBe(body.reference);

      const again = await json<{ url: string }>(
        await call("POST", `/api/orders/${order.id}/taypi-link`),
        201,
      );
      expect(again.url).toBe(link.url);
      expect(sent).toHaveLength(1);
    });

    it("refuses a balance over TAYPI's S/ 500 limit", async () => {
      await saveTaypiKeys(tenantId, KEYS);
      const order = await takeOrder(11);
      const refused = await json<{ reason: string }>(
        await call("POST", `/api/orders/${order.id}/taypi-link`),
        400,
      );
      expect(refused.reason).toBe("above_maximum");
    });
  });

  describe("when the customer pays", () => {
    let order: OrderDetail;
    let chargeId: string;

    beforeEach(async () => {
      await saveTaypiKeys(tenantId, KEYS);
      order = await takeOrder();
      const link = await json<{ url: string }>(
        await call("POST", `/api/orders/${order.id}/taypi-link`),
        201,
      );
      chargeId = link.url.split("/").pop()!;
    });

    const completed = () => ({
      event: "payment.completed",
      payment_id: "pay_123",
      amount: "99.80",
      reference: chargeId,
      payer_display_name: "Ana T.",
    });

    it("shows the public page what checkout.js needs", async () => {
      const page = await json<Record<string, any>>(
        await app.request(`/api/pay/${chargeId}`),
        200,
      );
      expect(page).toMatchObject({
        order_number: order.number,
        amount_cents: 9980,
        status: "pending",
        checkout: {
          public_key: KEYS.publicKey,
          token: "tok_1",
          script: "https://sandbox.taypi.pe/v2/checkout.js",
        },
      });
      expect(JSON.stringify(page)).not.toContain(KEYS.secretKey);
      expect((await app.request("/api/pay/nope")).status).toBe(404);
    });

    it("refuses a webhook signed with another secret", async () => {
      const response = await signedEvent(completed(), "another-secret-0000");
      expect(response.status).toBe(401);
      expect((await orderOf(order.id)).paid_cents).toBe(0);
    });

    it("confirms the payment once from the webhook, however often it arrives", async () => {
      expect((await signedEvent(completed())).status).toBe(200);
      expect((await signedEvent(completed())).status).toBe(200);

      const paidOrder = await orderOf(order.id);
      expect(paidOrder.paid_cents).toBe(9980);
      expect(paidOrder.payments).toHaveLength(1);
      expect(paidOrder.payments[0]).toMatchObject({
        status: "confirmed",
        amount_cents: 9980,
        method_name: TAYPI_METHOD_NAME,
        reference: "pay_123",
      });
      const page = await json<Record<string, unknown>>(
        await app.request(`/api/pay/${chargeId}`),
        200,
      );
      expect(page).toMatchObject({ status: "completed", checkout: null });
    });

    it("leaves a payment of another amount pending for staff", async () => {
      await signedEvent({ ...completed(), amount: "50.00" });
      const after = await orderOf(order.id);
      expect(after.payments).toHaveLength(1);
      expect(after.payments[0]).toMatchObject({
        status: "pending",
        amount_cents: 5000,
      });
      expect(after.paid_cents).toBe(0);
    });

    it("confirms it from the page's check when the webhook is late", async () => {
      // A check right after the link opened is throttled; age the charge.
      await db
        .updateTable("taypi_charges")
        .set({ updated_at: Date.now() - 60_000 })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", chargeId)
        .execute();
      paid.set(chargeId, [
        {
          payment_id: "pay_456",
          status: "completed",
          amount: "99.80",
          reference: chargeId,
        },
      ]);
      const page = await json<Record<string, unknown>>(
        await app.request(`/api/pay/${chargeId}/check`, { method: "POST" }),
        200,
      );
      expect(page.status).toBe("completed");
      expect((await orderOf(order.id)).paid_cents).toBe(9980);

      // The webhook that follows changes nothing.
      await signedEvent({ ...completed(), payment_id: "pay_456" });
      expect((await orderOf(order.id)).payments).toHaveLength(1);
    });

    it("throttles the check so a busy page stays inside TAYPI's rate limit", async () => {
      await app.request(`/api/pay/${chargeId}/check`, { method: "POST" });
      expect(sent.filter((s) => s.url.pathname === "/api/v1/payments")).toEqual(
        [],
      );
    });

    it("closes the charge when TAYPI reports it expired", async () => {
      await signedEvent({ ...completed(), event: "payment.expired" });
      expect((await TaypiCharges.get(chargeId))?.status).toBe("expired");
    });
  });

  describe("in the assistant", () => {
    const TOOLS = toolsFor({ caliddaCredit: false, staffCloses: false });
    let ctx: ToolContext;

    beforeEach(() => {
      ctx = {
        tenantId,
        channelAccountId,
        phone: "51987654321",
        simulated: false,
      };
    });

    const orderArgs = {
      customer_name: "Ana Torres",
      document_type: null,
      document_number: null,
      lines: [{ variant_id: "", quantity: 2 }],
      address: null,
      zone_id: null,
      payment_method_id: "taypi",
      notes: null,
    };

    it("offers the pay link only when TAYPI is connected", async () => {
      const before = await runTool(TOOLS, ctx, "list_payment_methods", {});
      expect(JSON.stringify(before.result)).not.toContain('"taypi"');

      await saveTaypiKeys(tenantId, KEYS);
      const after = await runTool(TOOLS, ctx, "list_payment_methods", {});
      expect(after.result).toMatchObject({
        payment_methods: [
          expect.objectContaining({ payment_method_id: "taypi" }),
        ],
      });
    });

    it("files the order with a pay link to send instead of a pending payment", async () => {
      await saveTaypiKeys(tenantId, KEYS);
      const outcome = await runTool(TOOLS, ctx, "create_order", {
        ...orderArgs,
        lines: [{ variant_id: variant.id, quantity: 2 }],
      });
      expect(outcome.result).toMatchObject({
        payment_method: "Yape, Plin o app de tu banco (link de pago)",
        payment_instructions: expect.stringContaining(
          `${publicOrigin()}/pagar/`,
        ),
      });
      const effect = outcome.effects[0];
      if (effect?.kind !== "order_created") throw new Error("no order");
      expect(effect.order.payments).toEqual([]);
    });

    it("tells the model to offer another method over S/ 500", async () => {
      await saveTaypiKeys(tenantId, KEYS);
      const outcome = await runTool(TOOLS, ctx, "create_order", {
        ...orderArgs,
        lines: [{ variant_id: variant.id, quantity: 11 }],
      });
      expect(outcome.result).toMatchObject({
        payment_instructions: expect.stringMatching(/otro medio/),
      });
    });

    it("refuses the method when TAYPI is not connected", async () => {
      const outcome = await runTool(TOOLS, ctx, "create_order", {
        ...orderArgs,
        lines: [{ variant_id: variant.id, quantity: 2 }],
      });
      expect(JSON.stringify(outcome.result)).toContain(
        "payment method not found",
      );
    });
  });
});
