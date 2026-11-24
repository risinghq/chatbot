import { encodeBase64 } from "@oslojs/encoding";
import { db, tenantScope } from "../../db/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { ShopifyConnections, type ShopifyLogin } from "./connection.ts";
import { ShopifyApi, type ShopifyProduct } from "./client.ts";
import {
  applyShopifyAvailable,
  shopifyLocation,
  upsertShopifyProduct,
} from "./sync.ts";

const logger = createLogger("shopify-webhook");

const encoder = new TextEncoder();

/**
 * The base64 HMAC-SHA256 of `rawBody` under `secret`, which is what Shopify
 * sends in `X-Shopify-Hmac-Sha256`.
 */
export async function shopifyHmac(
  secret: string,
  rawBody: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return encodeBase64(new Uint8Array(mac));
}

/** Constant-time check of a `X-Shopify-Hmac-Sha256` header. */
export async function shopifySignatureMatches(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const given = encoder.encode(header.trim());
  const expected = encoder.encode(await shopifyHmac(secret, rawBody));
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}

/**
 * One signed delivery. The topic names the handler; anything else is
 * acknowledged, so Shopify stops retrying a subscription the shop added and
 * we do not read.
 */
export async function handleShopifyWebhook(
  tenantId: string,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (topic === "products/update" || topic === "products/create") {
    await updateProduct(tenantId, payload);
  } else if (topic === "products/delete") {
    await deleteProduct(tenantId, payload);
  } else if (topic === "inventory_levels/update") {
    await updateInventory(tenantId, payload);
  } else {
    logger.info({ tenantId, topic }, "Shopify webhook topic not handled");
  }
}

/**
 * A product push carries the product; its variants' stock does not ride
 * along, so the levels are fetched for the items the payload names.
 */
async function updateProduct(
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const login = await ShopifyConnections.login(tenantId);
  if (!login) return;
  const product = payload as unknown as ShopifyProduct;
  if (typeof product.id !== "number" || !Array.isArray(product.variants)) {
    logger.warn({ tenantId }, "Shopify products/update with no product");
    return;
  }
  const location = await shopifyLocation(tenantId);
  const inventory = await inventoryOf(
    login,
    product.variants.map((v) => String(v.inventory_item_id)),
  );
  await upsertShopifyProduct(tenantId, product, inventory, location.id);
}

/** Levels of each item, summed over the store's locations. */
async function inventoryOf(
  login: ShopifyLogin,
  itemIds: string[],
): Promise<Map<string, number>> {
  const inventory = new Map<string, number>();
  for (let i = 0; i < itemIds.length; i += 50) {
    for (const level of await ShopifyApi.inventoryLevels(
      login,
      itemIds.slice(i, i + 50),
    )) {
      const key = String(level.inventory_item_id);
      inventory.set(key, (inventory.get(key) ?? 0) + level.available);
    }
  }
  return inventory;
}

/**
 * A deleted product is archived, not removed: it leaves the assistant's
 * catalog while its past order lines still resolve.
 */
async function deleteProduct(
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = payload.id;
  if (typeof id !== "number" && typeof id !== "string") return;
  await db
    .updateTable("products")
    .set({ status: "archived" })
    .where(tenantScope(tenantId))
    .where("shopify_product_id", "=", String(id))
    .execute();
}

async function updateInventory(
  tenantId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const itemId = payload.inventory_item_id;
  const available = payload.available;
  if (
    (typeof itemId !== "number" && typeof itemId !== "string") ||
    typeof available !== "number"
  ) {
    return;
  }
  const variant = await db
    .selectFrom("product_variants")
    .select("id")
    .where(tenantScope(tenantId))
    .where("shopify_inventory_item_id", "=", String(itemId))
    .executeTakeFirst();
  if (!variant) return;
  const location = await shopifyLocation(tenantId);

  // The event carries one location's `available`; the catalog tracks the
  // item's total over all of them. When a location is named, refetch the
  // item's levels and apply the summed total, like the full sync does.
  let total = available;
  if (payload.location_id !== undefined) {
    const login = await ShopifyConnections.login(tenantId);
    if (!login) return;
    const inventory = await inventoryOf(login, [String(itemId)]);
    total = inventory.get(String(itemId)) ?? 0;
  }

  await applyShopifyAvailable(
    tenantId,
    variant.id,
    location.id,
    total,
    "Inventario Shopify",
  );
}
