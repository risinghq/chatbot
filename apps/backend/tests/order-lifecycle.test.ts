/**
 * An order reserves its stocked lines when it is taken, takes them out when it
 * ships and gives them back when it is cancelled. Payments are recorded apart
 * from the status, and a sales agent reaches only their own orders.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type {
  DeliveryZone,
  OrderDetail,
  OrderSummary,
  Payment,
  PaymentMethod,
  Product,
  ProductVariant,
  ShipmentSummary,
  StockRow,
} from "@vendeya/types";

import { getAll } from "./helpers/db.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import catalogRoutes from "../src/routes/catalog.ts";
import customerRoutes from "../src/routes/customers.ts";
import orderRoutes from "../src/routes/orders.ts";
import { deliveryZones, paymentMethods } from "../src/routes/order-settings.ts";
import stockRoutes from "../src/routes/stock.ts";
import { createMember, createTenantFixture } from "./helpers/tenancy.ts";

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api/catalog", catalogRoutes);
app.route("/api/customers", customerRoutes);
app.route("/api/orders", orderRoutes);
app.route("/api/delivery-zones", deliveryZones);
app.route("/api/payment-methods", paymentMethods);
app.route("/api/stock", stockRoutes);
app.onError(errorHandler);

type Role = "admin" | "supervisor" | "sales_agent";
type Caller = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<Response>;

async function callerAs(tenantId: string, role: Role): Promise<Caller> {
  const { userId } = await createMember({ tenantId }, role);
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);
  return async (method, path, body) =>
    await app.request(path, {
      method,
      headers: {
        Cookie: `session=${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

const CUSTOMER = { name: "Ana Torres", phone: "51987654321" };

describe("an order", () => {
  let tenantId: string;
  let admin: Caller;
  let variant: ProductVariant;

  async function stockOf(): Promise<Pick<StockRow, "on_hand" | "reserved">> {
    const rows = await json<StockRow[]>(await admin("GET", "/api/stock"), 200);
    const row = rows.find((r) => r.variant_id === variant.id)!;
    return { on_hand: row.on_hand, reserved: row.reserved };
  }

  function take(caller: Caller, quantity: number, extra: object = {}) {
    return caller("POST", "/api/orders", {
      customer: CUSTOMER,
      lines: [{ variant_id: variant.id, quantity }],
      ...extra,
    });
  }

  function move(caller: Caller, order: { id: string }, status: string) {
    return caller("POST", `/api/orders/${order.id}/transition`, { status });
  }

  beforeEach(async () => {
    ({ tenantId } = await createTenantFixture("lifecycle"));
    admin = await callerAs(tenantId, "admin");

    const product = await json<Product>(
      await admin("POST", "/api/catalog/products", {
        name: "Polo básico",
        category: "ropa",
      }),
      200,
    );
    variant = await json<ProductVariant>(
      await admin("POST", `/api/catalog/products/${product.id}/variants`, {
        name: "M",
        sku: `POLO-${crypto.randomUUID().slice(0, 8)}`,
        price_cents: 4990,
      }),
      201,
    );
    await json(
      await admin("POST", "/api/stock/movements", {
        variant_id: variant.id,
        kind: "receive",
        quantity: 5,
      }),
      201,
    );
  });

  describe("when it is taken", () => {
    it("copies the catalog price, finds the customer by phone and reserves stock", async () => {
      const order = await json<OrderDetail>(await take(admin, 2), 201);

      expect(order).toMatchObject({
        status: "pending",
        source: "staff",
        subtotal_cents: 9980,
        total_cents: 9980,
        payment_state: "unpaid",
        customer: { name: CUSTOMER.name, phone: CUSTOMER.phone },
      });
      expect(order.lines).toEqual([
        expect.objectContaining({
          variant_id: variant.id,
          name: "Polo básico · M",
          unit_price_cents: 4990,
          quantity: 2,
        }),
      ]);
      expect(await stockOf()).toEqual({ on_hand: 5, reserved: 2 });

      const again = await json<OrderDetail>(await take(admin, 1), 201);
      expect(again.customer.id).toBe(order.customer.id);
      expect(again.number).toBe(order.number + 1);
    });

    it("refuses more than is available with 409 and writes nothing", async () => {
      await json(await take(admin, 4), 201);

      expect((await take(admin, 2)).status).toBe(409);

      expect(await stockOf()).toEqual({ on_hand: 5, reserved: 4 });
      const orders = await json<OrderSummary[]>(
        await admin("GET", "/api/orders"),
        200,
      );
      expect(orders).toHaveLength(1);
    });

    it("refuses a variant of another business with 400", async () => {
      const other = await createTenantFixture("lifecycle-other");
      const outsider = await callerAs(other.tenantId, "admin");

      expect((await take(outsider, 1)).status).toBe(400);
      expect(await stockOf()).toEqual({ on_hand: 5, reserved: 0 });
    });

    it("charges the zone's fee and names the customer as the recipient", async () => {
      const zone = await json<DeliveryZone>(
        await admin("POST", "/api/delivery-zones", {
          name: "Lima centro",
          fee_cents: 1000,
        }),
        201,
      );

      const order = await json<OrderDetail>(
        await take(admin, 1, {
          shipment: { zone_id: zone.id, address_line: "Av. Arequipa 123" },
        }),
        201,
      );

      expect(order).toMatchObject({
        delivery_fee_cents: 1000,
        total_cents: 5990,
        shipment: {
          zone_name: "Lima centro",
          recipient_name: CUSTOMER.name,
          address_line: "Av. Arequipa 123",
        },
      });
    });
  });

  describe("as it moves", () => {
    it("takes the reserved units out when it ships", async () => {
      const order = await json<OrderDetail>(await take(admin, 2), 201);

      for (const status of ["confirmed", "packed", "shipped"]) {
        await json(await move(admin, order, status), 200);
      }
      expect(await stockOf()).toEqual({ on_hand: 3, reserved: 0 });

      const delivered = await json<OrderDetail>(
        await move(admin, order, "delivered"),
        200,
      );
      expect(delivered.status).toBe("delivered");
      expect(await stockOf()).toEqual({ on_hand: 3, reserved: 0 });
    });

    it("takes them out on delivery of a pickup", async () => {
      const order = await json<OrderDetail>(await take(admin, 2), 201);

      for (const status of ["confirmed", "packed", "delivered"]) {
        await json(await move(admin, order, status), 200);
      }
      expect(await stockOf()).toEqual({ on_hand: 3, reserved: 0 });
    });

    it("gives the units back when it is cancelled", async () => {
      const order = await json<OrderDetail>(await take(admin, 2), 201);
      await json(await move(admin, order, "confirmed"), 200);

      await json(await move(admin, order, "cancelled"), 200);

      expect(await stockOf()).toEqual({ on_hand: 5, reserved: 0 });
      const kinds = await getAll<{ kind: string }>(
        "SELECT kind FROM stock_movements WHERE order_id = ? ORDER BY id",
        [order.id],
      );
      expect(kinds.map((k) => k.kind)).toEqual(["reserve", "release"]);
    });

    it("refuses a move its status does not allow with 409, and moves no stock", async () => {
      const order = await json<OrderDetail>(await take(admin, 2), 201);

      expect((await move(admin, order, "shipped")).status).toBe(409);
      expect((await move(admin, order, "pending")).status).toBe(409);

      for (const status of ["confirmed", "packed", "shipped"]) {
        await json(await move(admin, order, status), 200);
      }
      expect((await move(admin, order, "cancelled")).status).toBe(409);
      expect(await stockOf()).toEqual({ on_hand: 3, reserved: 0 });
    });

    it("lets one of two concurrent moves apply", async () => {
      const order = await json<OrderDetail>(await take(admin, 2), 201);
      await json(await move(admin, order, "confirmed"), 200);

      const results = await Promise.all([
        move(admin, order, "cancelled"),
        move(admin, order, "packed"),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const stock = await stockOf();
      expect(stock.on_hand).toBe(5);
      expect([0, 2]).toContain(stock.reserved);
    });

    it("leaves fulfilment to supervisors and cancelling to admins and supervisors", async () => {
      const agent = await callerAs(tenantId, "sales_agent");
      const supervisor = await callerAs(tenantId, "supervisor");
      const order = await json<OrderDetail>(await take(agent, 1), 201);

      expect((await move(agent, order, "confirmed")).status).toBe(403);
      expect((await move(agent, order, "cancelled")).status).toBe(403);
      await json(await move(supervisor, order, "cancelled"), 200);
    });
  });

  describe("its payments", () => {
    let order: OrderDetail;

    beforeEach(async () => {
      order = await json<OrderDetail>(await take(admin, 2), 201);
    });

    function pay(caller: Caller, body: object) {
      return caller("POST", `/api/orders/${order.id}/payments`, body);
    }

    function decide(caller: Caller, payment: Payment, action: string) {
      return caller(
        "POST",
        `/api/orders/${order.id}/payments/${payment.id}/${action}`,
      );
    }

    it("count toward the order only once confirmed", async () => {
      const method = await json<PaymentMethod>(
        await admin("POST", "/api/payment-methods", {
          name: "Yape",
          instructions: "Al 987 654 321",
        }),
        201,
      );

      const first = await json<Payment>(
        await pay(admin, { method_id: method.id, amount_cents: 5000 }),
        201,
      );
      expect(first).toMatchObject({ status: "pending", method_name: "Yape" });

      let detail = await json<OrderDetail>(
        await admin("GET", `/api/orders/${order.id}`),
        200,
      );
      expect(detail.payment_state).toBe("unpaid");

      detail = await json<OrderDetail>(
        await decide(admin, first, "confirm"),
        200,
      );
      expect(detail).toMatchObject({
        paid_cents: 5000,
        payment_state: "partial",
      });

      const rest = await json<Payment>(
        await pay(admin, { method_name: "Efectivo", amount_cents: 4980 }),
        201,
      );
      detail = await json<OrderDetail>(
        await decide(admin, rest, "confirm"),
        200,
      );
      expect(detail).toMatchObject({ paid_cents: 9980, payment_state: "paid" });
    });

    it("are decided once, and a rejected one counts for nothing", async () => {
      const payment = await json<Payment>(
        await pay(admin, { method_name: "Transferencia", amount_cents: 9980 }),
        201,
      );

      const detail = await json<OrderDetail>(
        await decide(admin, payment, "reject"),
        200,
      );
      expect(detail.payment_state).toBe("unpaid");
      expect((await decide(admin, payment, "confirm")).status).toBe(409);
    });

    it("are recorded by a sales agent and decided only by an admin or supervisor", async () => {
      const agent = await callerAs(tenantId, "sales_agent");
      const mine = await json<OrderDetail>(await take(agent, 1), 201);

      const payment = await json<Payment>(
        await agent("POST", `/api/orders/${mine.id}/payments`, {
          method_name: "Yape",
          amount_cents: 4990,
        }),
        201,
      );
      expect(
        (
          await agent(
            "POST",
            `/api/orders/${mine.id}/payments/${payment.id}/confirm`,
          )
        ).status,
      ).toBe(403);
    });

    it("are refused on a cancelled order and without a method", async () => {
      expect((await pay(admin, { amount_cents: 100 })).status).toBe(400);
      expect(
        (await pay(admin, { method_name: "Yape", amount_cents: 0 })).status,
      ).toBe(400);

      await json(await move(admin, order, "cancelled"), 200);
      expect(
        (await pay(admin, { method_name: "Yape", amount_cents: 100 })).status,
      ).toBe(409);
    });
  });

  describe("the shipments list", () => {
    it("lists orders that ship in the statuses asked for, not pickups", async () => {
      const shipped = await json<OrderDetail>(
        await take(admin, 1, {
          shipment: { address_line: "Av. Arequipa 123", district: "Lince" },
        }),
        201,
      );
      await json(await take(admin, 1), 201);
      const later = await json<OrderDetail>(
        await take(admin, 1, { shipment: { address_line: "Jr. Puno 4" } }),
        201,
      );
      await json(await move(admin, later, "confirmed"), 200);

      const pending = await json<ShipmentSummary[]>(
        await admin("GET", "/api/orders/shipments?status=pending"),
        200,
      );
      expect(pending).toEqual([
        expect.objectContaining({
          order_id: shipped.id,
          order_number: shipped.number,
          order_status: "pending",
          customer_name: CUSTOMER.name,
          address_line: "Av. Arequipa 123",
          district: "Lince",
          payment_state: "unpaid",
        }),
      ]);

      const both = await json<ShipmentSummary[]>(
        await admin("GET", "/api/orders/shipments?status=pending,confirmed"),
        200,
      );
      expect(both.map((s) => s.order_id)).toEqual([later.id, shipped.id]);
    });

    it("refuses a missing or unknown status with 400", async () => {
      for (const query of ["", "?status=", "?status=pending,lost"]) {
        expect(
          (await admin("GET", `/api/orders/shipments${query}`)).status,
        ).toBe(400);
      }
    });

    it("shows a sales agent only their own orders", async () => {
      const agent = await callerAs(tenantId, "sales_agent");
      const address = { shipment: { address_line: "Av. Brasil 9" } };
      await json(await take(admin, 1, address), 201);
      const mine = await json<OrderDetail>(await take(agent, 1, address), 201);

      const listed = await json<ShipmentSummary[]>(
        await agent("GET", "/api/orders/shipments?status=pending"),
        200,
      );
      expect(listed.map((s) => s.order_id)).toEqual([mine.id]);
    });
  });

  describe("for a sales agent", () => {
    it("is reachable only when the agent took it", async () => {
      const agent = await callerAs(tenantId, "sales_agent");
      const colleague = await callerAs(tenantId, "sales_agent");
      const theirs = await json<OrderDetail>(await take(colleague, 1), 201);
      const mine = await json<OrderDetail>(await take(agent, 1), 201);

      const listed = await json<OrderSummary[]>(
        await agent("GET", "/api/orders"),
        200,
      );
      expect(listed.map((o) => o.id)).toEqual([mine.id]);

      expect((await agent("GET", `/api/orders/${theirs.id}`)).status).toBe(404);
      expect(
        (
          await agent("POST", `/api/orders/${theirs.id}/payments`, {
            method_name: "Yape",
            amount_cents: 100,
          })
        ).status,
      ).toBe(404);

      const all = await json<OrderSummary[]>(
        await admin("GET", "/api/orders"),
        200,
      );
      expect(all).toHaveLength(2);
    });
  });

  describe("settings", () => {
    it("refuse a second zone of the same name, and a sales agent's write", async () => {
      await json(
        await admin("POST", "/api/delivery-zones", {
          name: "Callao",
          fee_cents: 800,
        }),
        201,
      );
      expect(
        (
          await admin("POST", "/api/delivery-zones", {
            name: "Callao",
            fee_cents: 500,
          })
        ).status,
      ).toBe(409);

      const agent = await callerAs(tenantId, "sales_agent");
      expect(
        (await agent("POST", "/api/payment-methods", { name: "Plin" })).status,
      ).toBe(403);
      const zones = await json<DeliveryZone[]>(
        await agent("GET", "/api/delivery-zones"),
        200,
      );
      expect(zones.map((z) => z.name)).toEqual(["Callao"]);
    });

    it("refuse a zone that is not active on a new order", async () => {
      const zone = await json<DeliveryZone>(
        await admin("POST", "/api/delivery-zones", {
          name: "Sur",
          fee_cents: 900,
        }),
        201,
      );
      await json(
        await admin("PATCH", `/api/delivery-zones/${zone.id}`, {
          is_active: false,
        }),
        200,
      );

      const response = await take(admin, 1, {
        shipment: { zone_id: zone.id, address_line: "Jr. Puno 4" },
      });
      expect(response.status).toBe(400);
      expect(await stockOf()).toEqual({ on_hand: 5, reserved: 0 });
    });
  });

  describe("its customer", () => {
    it("cannot be deleted while the order exists", async () => {
      const order = await json<OrderDetail>(await take(admin, 1), 201);

      expect(
        (await admin("DELETE", `/api/customers/${order.customer.id}`)).status,
      ).toBe(409);
      await json(
        await admin("GET", `/api/customers/${order.customer.id}`),
        200,
      );
    });
  });
});
