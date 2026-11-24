/**
 * A business connects its Shopify store: the import brings the catalog and
 * stock, the signed webhooks keep them in step, and a confirmed order is
 * written back with its Shopify id on the order.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getAll, getOne, run } from "./helpers/db.ts";
import {
  fakeShopify,
  shopifyProduct,
  shopifySignature,
} from "./helpers/shopify.ts";
import { insertTenant } from "./helpers/tenancy.ts";
import { CustomerService } from "../src/domains/customers/index.ts";
import { OrderWrites } from "../src/domains/orders/index.ts";
import { ShopifyConnections } from "../src/domains/shopify/connection.ts";
import { dispatchDueShopifyOrderSyncs } from "../src/domains/shopify/order-sync.ts";
import { syncFromShopify } from "../src/domains/shopify/sync.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import shopifyWebhook from "../src/routes/shopify-webhook.ts";
import { errorHandler } from "../src/middleware/error.ts";
import { newId } from "@vendeya/utils";

const TOKEN = "shpat_test_token";
const SECRET = "whsec_shopify_test";

const app = new Hono();
app.route("/api/webhook/shopify", shopifyWebhook);
app.onError(errorHandler);

let fake: ReturnType<typeof fakeShopify> | null = null;
afterEach(() => fake?.restore());

async function connect(tenantId: string) {
  await ShopifyConnections.connect(
    tenantId,
    "tienda.myshopify.com",
    TOKEN,
    SECRET,
  );
}

async function post(
  tenantId: string,
  topic: string,
  body: object,
  sign = true,
) {
  const raw = JSON.stringify(body);
  return app.request(`/api/webhook/shopify/${tenantId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Hmac-Sha256": sign
        ? await shopifySignature(SECRET, raw)
        : "bad",
    },
    body: raw,
  });
}

describe("shopify sync", () => {
  it("imports the catalog and updates it without duplicates", async () => {
    const tenantId = await insertTenant();
    await connect(tenantId);
    fake = fakeShopify({
      products: [shopifyProduct()],
      inventoryLevels: [
        { inventory_item_id: 90001, available: 7 },
        { inventory_item_id: 90002, available: 3 },
      ],
    });

    const first = await syncFromShopify(tenantId);
    expect(first).toMatchObject({ products: 1, created: 1, updated: 0 });

    const products = await ProductService.getAll(tenantId);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      name: "Polo clásico",
      category: "Ropa",
      brand: "Marca",
      shopify_product_id: "7001",
    });
    const variants = await getAll<{ sku: string; price_cents: number }>(
      "SELECT sku, price_cents FROM product_variants WHERE tenant_id = ?",
      [tenantId],
    );
    expect(variants.map((v) => v.sku).sort()).toEqual([
      "POLO-L-ROJO",
      "POLO-M-ROJO",
    ]);
    expect(variants[0]!.price_cents).toBe(4990);

    const levels = await getAll<{ on_hand: number }>(
      "SELECT on_hand FROM stock_levels WHERE tenant_id = ? ORDER BY on_hand",
      [tenantId],
    );
    expect(levels.map((l) => l.on_hand)).toEqual([3, 7]);

    const images = await getAll(
      "SELECT id FROM product_images WHERE tenant_id = ?",
      [tenantId],
    );
    expect(images).toHaveLength(1);

    // Re-run with a changed price and stock: same rows, new values.
    fake.restore();
    const changed = shopifyProduct();
    (changed.variants[0] as { price: string }).price = "59.90";
    fake = fakeShopify({
      products: [changed],
      inventoryLevels: [
        { inventory_item_id: 90001, available: 10 },
        { inventory_item_id: 90002, available: 3 },
      ],
    });
    const second = await syncFromShopify(tenantId);
    expect(second).toMatchObject({ products: 1, created: 0, updated: 1 });

    const after = await ProductService.getAll(tenantId);
    expect(after).toHaveLength(1);
    expect(
      await getAll("SELECT id FROM product_variants WHERE tenant_id = ?", [
        tenantId,
      ]),
    ).toHaveLength(2);
    expect(
      await getOne<{ price_cents: number }>(
        "SELECT price_cents FROM product_variants WHERE tenant_id = ? AND sku = 'POLO-M-ROJO'",
        [tenantId],
      ),
    ).toMatchObject({ price_cents: 5990 });
    expect(
      await getAll<{ on_hand: number }>(
        "SELECT on_hand FROM stock_levels WHERE tenant_id = ? ORDER BY on_hand",
        [tenantId],
      ).then((rows) => rows.map((r) => r.on_hand)),
    ).toEqual([3, 10]);
  });

  it("applies a products/update webhook and refuses a bad signature", async () => {
    const tenantId = await insertTenant();
    await connect(tenantId);
    fake = fakeShopify({
      products: [],
      inventoryLevels: [{ inventory_item_id: 90001, available: 9 }],
    });

    const update = shopifyProduct({ title: "Polo premium" });
    expect(
      (await post(tenantId, "products/update", update, false)).status,
    ).toBe(401);
    expect(await ProductService.getAll(tenantId)).toHaveLength(0);

    const ok = await post(tenantId, "products/update", update);
    expect(ok.status).toBe(200);
    const [product] = await ProductService.getAll(tenantId);
    expect(product?.name).toBe("Polo premium");
    expect(
      await getOne<{ on_hand: number }>(
        `SELECT l.on_hand FROM stock_levels l
         JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
         WHERE v.tenant_id = ? AND v.shopify_variant_id = '8001'`,
        [tenantId],
      ),
    ).toMatchObject({ on_hand: 9 });
  });

  it("hides a deleted product without dropping it", async () => {
    const tenantId = await insertTenant();
    await connect(tenantId);
    fake = fakeShopify({ products: [shopifyProduct()], inventoryLevels: [] });
    await syncFromShopify(tenantId);

    expect(
      (await post(tenantId, "products/delete", { id: 7001 }, false)).status,
    ).toBe(401);
    expect((await post(tenantId, "products/delete", { id: 7001 })).status).toBe(
      200,
    );

    const product = await getOne<{ status: string }>(
      "SELECT status FROM products WHERE tenant_id = ? AND shopify_product_id = '7001'",
      [tenantId],
    );
    expect(product?.status).toBe("archived");
  });

  it("moves stock on inventory_levels/update and ignores bad signatures", async () => {
    const tenantId = await insertTenant();
    await connect(tenantId);
    fake = fakeShopify({
      products: [shopifyProduct()],
      inventoryLevels: [
        { inventory_item_id: 90001, location_id: 1, available: 4 },
        { inventory_item_id: 90001, location_id: 2, available: 6 },
      ],
    });
    await syncFromShopify(tenantId);

    const level = () =>
      getOne<{ on_hand: number }>(
        `SELECT l.on_hand FROM stock_levels l
         JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
         WHERE v.tenant_id = ? AND v.shopify_inventory_item_id = '90001'`,
        [tenantId],
      );

    expect((await level())?.on_hand).toBe(10);
    expect(
      (
        await post(
          tenantId,
          "inventory_levels/update",
          { inventory_item_id: 90001, location_id: 2, available: 5 },
          false,
        )
      ).status,
    ).toBe(401);
    expect((await level())?.on_hand).toBe(10);

    // The event names location 2's new level; the stock follows the total
    // over both locations, refetched: 4 + 5, not the event's 5.
    fake.restore();
    fake = fakeShopify({
      inventoryLevels: [
        { inventory_item_id: 90001, location_id: 1, available: 4 },
        { inventory_item_id: 90001, location_id: 2, available: 5 },
      ],
    });
    expect(
      (
        await post(tenantId, "inventory_levels/update", {
          inventory_item_id: 90001,
          location_id: 2,
          available: 5,
        })
      ).status,
    ).toBe(200);
    expect((await level())?.on_hand).toBe(9);
  });

  it("lands the Shopify total once for concurrent inventory updates", async () => {
    const tenantId = await insertTenant();
    await connect(tenantId);
    fake = fakeShopify({
      products: [shopifyProduct()],
      inventoryLevels: [
        { inventory_item_id: 90001, location_id: 1, available: 4 },
        { inventory_item_id: 90001, location_id: 2, available: 6 },
      ],
    });
    await syncFromShopify(tenantId);

    // Two deliveries of the same event race: the delta rides in the
    // statement, so the stock lands on Shopify's total once, not twice.
    fake.restore();
    fake = fakeShopify({
      inventoryLevels: [
        { inventory_item_id: 90001, location_id: 1, available: 4 },
        { inventory_item_id: 90001, location_id: 2, available: 5 },
      ],
    });
    const payload = {
      inventory_item_id: 90001,
      location_id: 2,
      available: 5,
    };
    const [first, second] = await Promise.all([
      post(tenantId, "inventory_levels/update", payload),
      post(tenantId, "inventory_levels/update", payload),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(
      (
        await getOne<{ on_hand: number }>(
          `SELECT l.on_hand FROM stock_levels l
           JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
           WHERE v.tenant_id = ? AND v.shopify_inventory_item_id = '90001'`,
          [tenantId],
        )
      )?.on_hand,
    ).toBe(9);
    expect(
      await getOne<{ n: number; net: number }>(
        `SELECT COUNT(*) n, COALESCE(SUM(m.quantity), 0) net
         FROM stock_movements m
         JOIN product_variants v ON v.id = m.variant_id AND v.tenant_id = m.tenant_id
         WHERE v.tenant_id = ? AND v.shopify_inventory_item_id = '90001'
           AND m.kind = 'adjust' AND m.note = 'Inventario Shopify'`,
        [tenantId],
      ),
    ).toMatchObject({ n: 1, net: -1 });
  });

  it("writes a confirmed order back and keeps the Shopify id", async () => {
    const tenantId = await insertTenant();
    await connect(tenantId);
    fake = fakeShopify({
      products: [shopifyProduct()],
      inventoryLevels: [{ inventory_item_id: 90001, available: 5 }],
      orderId: 612001,
    });
    await syncFromShopify(tenantId);

    const variant = await getOne<{ id: string }>(
      "SELECT id FROM product_variants WHERE tenant_id = ? AND shopify_variant_id = '8001'",
      [tenantId],
    );
    const customer = await CustomerService.upsertByPhone(tenantId, {
      phone: "51999000111",
      name: "Ana",
    });
    const order = await OrderWrites.create({
      tenantId,
      customer,
      channelAccountId: null,
      source: "assistant",
      createdBy: null,
      lines: [{ variantId: variant!.id, quantity: 2 }],
    });

    await OrderWrites.transition(tenantId, order.id, "confirmed", null);
    expect(
      await getOne(
        "SELECT status FROM shopify_order_syncs WHERE order_id = ?",
        [order.id],
      ),
    ).toMatchObject({ status: "pending" });

    // Shopify's 500 leaves the sync failed with its error on the order.
    fake.failOrders();
    await dispatchDueShopifyOrderSyncs(Date.now());
    expect(
      await getOne<{ status: string; last_error: string | null }>(
        "SELECT status, last_error FROM shopify_order_syncs WHERE order_id = ?",
        [order.id],
      ),
    ).toMatchObject({ status: "failed", last_error: "broken" });

    // The next due sweep retries and keeps the id it gets.
    fake.succeedOrders();
    await run(
      "UPDATE shopify_order_syncs SET next_attempt_at = 0 WHERE order_id = ?",
      [order.id],
    );
    await dispatchDueShopifyOrderSyncs(Date.now());

    const [create] = fake.to("/admin/api/2025-01/orders.json").slice(-1);
    expect(create?.payload).toMatchObject({
      order: {
        line_items: [{ variant_id: 8001, quantity: 2 }],
      },
    });
    expect(
      await getOne<{ shopify_order_id: string }>(
        "SELECT shopify_order_id FROM orders WHERE id = ?",
        [order.id],
      ),
    ).toMatchObject({ shopify_order_id: "612001" });
    expect(
      await getOne(
        "SELECT status FROM shopify_order_syncs WHERE order_id = ?",
        [order.id],
      ),
    ).toMatchObject({ status: "synced" });
  });

  it("sums every location through paged inventory levels", async () => {
    const tenantId = await insertTenant();
    await connect(tenantId);
    fake = fakeShopify({
      products: [shopifyProduct()],
      inventoryLevels: [
        { inventory_item_id: 90001, location_id: 1, available: 4 },
        { inventory_item_id: 90002, location_id: 1, available: 2 },
        { inventory_item_id: 90001, location_id: 2, available: 6 },
        { inventory_item_id: 90002, location_id: 2, available: 1 },
      ],
      pageSize: 2,
    });
    await syncFromShopify(tenantId);

    const levels = await getAll<{ sid: string; on_hand: number }>(
      `SELECT v.shopify_variant_id sid, l.on_hand FROM stock_levels l
       JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
       WHERE v.tenant_id = ? ORDER BY sid`,
      [tenantId],
    );
    expect(levels).toEqual([
      { sid: "8001", on_hand: 10 },
      { sid: "8002", on_hand: 3 },
    ]);
    // The four rows arrived over two pages.
    expect(
      fake.to(
        "/admin/api/2025-01/inventory_levels.json?limit=250&inventory_item_ids=90001,90002",
      ).length +
        fake.calls.filter((c) =>
          c.path.startsWith("/admin/api/2025-01/inventory_levels.json"),
        ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps the sync row open when writing the Shopify id fails", async () => {
    const tenantId = await insertTenant();
    await connect(tenantId);
    fake = fakeShopify({
      products: [shopifyProduct()],
      inventoryLevels: [{ inventory_item_id: 90001, available: 5 }],
      orderId: 612002,
    });
    await syncFromShopify(tenantId);

    const variant = await getOne<{ id: string }>(
      "SELECT id FROM product_variants WHERE tenant_id = ? AND shopify_variant_id = '8001'",
      [tenantId],
    );
    const customer = await CustomerService.upsertByPhone(tenantId, {
      phone: "51999000333",
      name: "Mia",
    });
    const order = await OrderWrites.create({
      tenantId,
      customer,
      channelAccountId: null,
      source: "assistant",
      createdBy: null,
      lines: [{ variantId: variant!.id, quantity: 1 }],
    });
    await OrderWrites.transition(tenantId, order.id, "confirmed", null);

    // Shopify answers, but the write of its id onto the order aborts: the
    // sync row must not claim synced, and no id may remain half-written.
    await run(
      `CREATE TRIGGER fail_order_write BEFORE UPDATE ON orders
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    await dispatchDueShopifyOrderSyncs(Date.now());
    expect(
      await getOne<{ status: string; shopify_order_id: string | null }>(
        `SELECT s.status, o.shopify_order_id FROM shopify_order_syncs s
         JOIN orders o ON o.id = s.order_id AND o.tenant_id = s.tenant_id
         WHERE s.order_id = ?`,
        [order.id],
      ),
    ).toMatchObject({ status: "failed", shopify_order_id: null });

    await run("DROP TRIGGER fail_order_write");
    await run(
      "UPDATE shopify_order_syncs SET next_attempt_at = 0 WHERE order_id = ?",
      [order.id],
    );
    await dispatchDueShopifyOrderSyncs(Date.now());
    expect(
      await getOne<{ status: string; shopify_order_id: string | null }>(
        `SELECT s.status, o.shopify_order_id FROM shopify_order_syncs s
         JOIN orders o ON o.id = s.order_id AND o.tenant_id = s.tenant_id
         WHERE s.order_id = ?`,
        [order.id],
      ),
    ).toMatchObject({ status: "synced", shopify_order_id: "612002" });
  });

  it("enqueues nothing for an unconnected business", async () => {
    const tenantId = await insertTenant();
    const variantId = newId();
    const customer = await CustomerService.upsertByPhone(tenantId, {
      phone: "51999000222",
      name: "Luis",
    });
    const order = await OrderWrites.create({
      tenantId,
      customer,
      channelAccountId: null,
      source: "assistant",
      createdBy: null,
      lines: [{ name: "Servicio", quantity: 1, unitPriceCents: 5000 }],
    });
    await OrderWrites.transition(tenantId, order.id, "confirmed", null);
    expect(
      await getAll(
        "SELECT order_id FROM shopify_order_syncs WHERE tenant_id = ?",
        [tenantId],
      ),
    ).toHaveLength(0);
    expect(variantId).toBeTruthy();
  });
});
