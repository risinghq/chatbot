/**
 * Stock moves only through the ledger. Each movement and its level change land
 * together or not at all, and a business never sees or touches another's
 * variants, locations or stock.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type {
  Product,
  ProductVariant,
  StockLocation,
  StockMovement,
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
import stockRoutes from "../src/routes/stock.ts";
import { DEFAULT_LOCATION_NAME } from "../src/domains/stock/index.ts";
import { createMember, createTenantFixture } from "./helpers/tenancy.ts";

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api/catalog", catalogRoutes);
app.route("/api/stock", stockRoutes);
app.onError(errorHandler);

type Caller = (
  method: string,
  path: string,
  body?: unknown,
) => Response | Promise<Response>;

/** A member of `tenant`, or the admin of a new business named `tenant`. */
async function callerFor(
  tenant: string | { tenantId: string },
  role: "admin" | "sales_agent" = "admin",
): Promise<{ call: Caller; tenantId: string }> {
  const { tenantId } =
    typeof tenant === "string" ? await createTenantFixture(tenant) : tenant;
  const { userId } = await createMember({ tenantId }, role);
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);

  const call: Caller = (method, path, body) =>
    app.request(path, {
      method,
      headers: {
        Cookie: `session=${token}`,
        "X-Tenant-Id": tenantId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, tenantId };
}

async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

async function createVariant(
  call: Caller,
  sku: string,
): Promise<ProductVariant> {
  const product = await json<Product>(
    await call("POST", "/api/catalog/products", {
      name: "Polo básico",
      category: "ropa",
    }),
    200,
  );
  return await json<ProductVariant>(
    await call("POST", `/api/catalog/products/${product.id}/variants`, {
      name: "Rojo / M",
      sku,
      price_cents: 4990,
      cost_cents: 2100,
    }),
    201,
  );
}

function move(call: Caller, variantId: string, kind: string, quantity: number) {
  return call("POST", "/api/stock/movements", {
    variant_id: variantId,
    kind,
    quantity,
  });
}

async function rowOf(call: Caller, variantId: string): Promise<StockRow> {
  const rows = await json<StockRow[]>(await call("GET", "/api/stock"), 200);
  return rows.find((row) => row.variant_id === variantId)!;
}

describe("the stock ledger", () => {
  let call: Caller;
  let tenantId: string;
  let variant: ProductVariant;

  beforeEach(async () => {
    ({ call, tenantId } = await callerFor("ledger"));
    variant = await createVariant(call, `POLO-${crypto.randomUUID()}`);
  });

  it("gives a product a v7 id and counts its variants", async () => {
    const products = await json<Product[]>(
      await call("GET", "/api/catalog/products"),
      200,
    );
    expect(products[0]!.id).toMatch(/^[0-9a-f-]{14}7/);
    expect(products[0]!.variant_count).toBe(1);
    expect(products[0]!.status).toBe("active");
  });

  it("shows a new variant with no stock", async () => {
    expect(await rowOf(call, variant.id)).toMatchObject({
      on_hand: 0,
      reserved: 0,
      available: 0,
      price_cents: 4990,
    });
  });

  it("moves on hand and reserved by each kind", async () => {
    await json(await move(call, variant.id, "receive", 10), 201);
    await json(await move(call, variant.id, "reserve", 4), 201);
    await json(await move(call, variant.id, "ship", 3), 201);
    await json(await move(call, variant.id, "release", 1), 201);
    await json(await move(call, variant.id, "adjust", -2), 201);

    expect(await rowOf(call, variant.id)).toMatchObject({
      on_hand: 5,
      reserved: 0,
      available: 5,
    });

    const movements = await json<StockMovement[]>(
      await call("GET", `/api/stock/movements?variant_id=${variant.id}`),
      200,
    );
    expect(movements.map((m) => m.kind)).toEqual([
      "adjust",
      "release",
      "ship",
      "reserve",
      "receive",
    ]);
  });

  it("puts stock in a default location created on first use", async () => {
    await json(await move(call, variant.id, "receive", 1), 201);
    await json(await move(call, variant.id, "receive", 1), 201);

    const locations = await json<StockLocation[]>(
      await call("GET", "/api/stock/locations"),
      200,
    );
    expect(locations.map((l) => l.name)).toEqual([DEFAULT_LOCATION_NAME]);
  });

  it("refuses a movement that would leave negative stock, and writes nothing", async () => {
    await json(await move(call, variant.id, "receive", 2), 201);

    expect((await move(call, variant.id, "adjust", -3)).status).toBe(409);
    expect((await move(call, variant.id, "reserve", 3)).status).toBe(409);
    expect((await move(call, variant.id, "ship", 1)).status).toBe(409);

    expect(await rowOf(call, variant.id)).toMatchObject({
      on_hand: 2,
      reserved: 0,
    });
    const ledger = await getAll(
      `SELECT kind FROM stock_movements WHERE variant_id = ?`,
      [variant.id],
    );
    expect(ledger).toHaveLength(1);
  });

  it("refuses a quantity that does not fit its kind", async () => {
    expect((await move(call, variant.id, "receive", -1)).status).toBe(400);
    expect((await move(call, variant.id, "adjust", 0)).status).toBe(400);
    expect((await move(call, variant.id, "receive", 1.5)).status).toBe(400);
    expect((await move(call, variant.id, "steal", 1)).status).toBe(400);
  });

  it("keeps stock per location", async () => {
    await json(await move(call, variant.id, "receive", 2), 201);
    const shop = await json<StockLocation>(
      await call("POST", "/api/stock/locations", { name: "Tienda Miraflores" }),
      201,
    );
    await json(
      await call("POST", "/api/stock/movements", {
        variant_id: variant.id,
        location_id: shop.id,
        kind: "receive",
        quantity: 7,
      }),
      201,
    );
    // With two locations, a movement must say which one.
    expect((await move(call, variant.id, "receive", 1)).status).toBe(400);

    const atShop = await json<StockRow[]>(
      await call("GET", `/api/stock?location_id=${shop.id}`),
      200,
    );
    expect(atShop.find((r) => r.variant_id === variant.id)?.on_hand).toBe(7);
    expect((await rowOf(call, variant.id)).on_hand).toBe(9);
    expect(
      (
        await call("POST", "/api/stock/locations", {
          name: "Tienda Miraflores",
        })
      ).status,
    ).toBe(409);
  });

  it("lists the stock of one product", async () => {
    await json(await move(call, variant.id, "receive", 4), 201);
    const other = await createVariant(call, "OTRO-1");

    const rows = await json<StockRow[]>(
      await call("GET", `/api/stock?product_id=${variant.product_id}`),
      200,
    );

    expect(rows.map((r) => [r.variant_id, r.available])).toEqual([
      [variant.id, 4],
    ]);
    expect(rows.some((r) => r.variant_id === other.id)).toBe(false);
  });

  it("refuses a SKU the business already uses", async () => {
    const product = await json<Product>(
      await call("POST", "/api/catalog/products", {
        name: "Otro",
        category: "ropa",
      }),
      200,
    );
    const response = await call(
      "POST",
      `/api/catalog/products/${product.id}/variants`,
      { sku: variant.sku, price_cents: 100 },
    );
    expect(response.status).toBe(409);
  });

  it("updates a variant's price and SKU", async () => {
    const updated = await json<ProductVariant>(
      await call("PATCH", `/api/catalog/variants/${variant.id}`, {
        price_cents: 3990,
        is_active: false,
      }),
      200,
    );
    expect(updated).toMatchObject({
      price_cents: 3990,
      is_active: 0,
      sku: variant.sku,
    });
    expect(
      (
        await call("PATCH", `/api/catalog/variants/${variant.id}`, {
          price_cents: -1,
        })
      ).status,
    ).toBe(400);
  });

  it("lets a sales agent read stock but not move it", async () => {
    const agent = await callerFor({ tenantId }, "sales_agent");
    expect((await rowOf(agent.call, variant.id)).sku).toBe(variant.sku);
    expect((await move(agent.call, variant.id, "receive", 1)).status).toBe(403);
  });
});

describe("stock across businesses", () => {
  it("never shows or moves another business's variant", async () => {
    const shopA = await callerFor("shop-a");
    const shopB = await callerFor("shop-b");
    const variantA = await createVariant(
      shopA.call,
      `A-${crypto.randomUUID()}`,
    );

    const rowsB = await json<StockRow[]>(
      await shopB.call("GET", "/api/stock"),
      200,
    );
    expect(rowsB.map((r) => r.variant_id)).not.toContain(variantA.id);

    expect((await move(shopB.call, variantA.id, "receive", 5)).status).toBe(
      404,
    );
    expect(
      (
        await shopB.call("PATCH", `/api/catalog/variants/${variantA.id}`, {
          price_cents: 1,
        })
      ).status,
    ).toBe(404);

    await json(await move(shopA.call, variantA.id, "receive", 1), 201);
    const [locationA] = await json<StockLocation[]>(
      await shopA.call("GET", "/api/stock/locations"),
      200,
    );
    const variantB = await createVariant(
      shopB.call,
      `B-${crypto.randomUUID()}`,
    );
    expect(
      (
        await shopB.call("POST", "/api/stock/movements", {
          variant_id: variantB.id,
          location_id: locationA!.id,
          kind: "receive",
          quantity: 1,
        })
      ).status,
    ).toBe(404);
  });
});
