import type { ProductStatus, StockLocation } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { sql, type Compilable } from "kysely";
import { imageStorage } from "../../adapters/storage/images.ts";
import { batch, db, tenantScope } from "../../db/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { StockService } from "../stock/index.ts";
import { ShopifyApi, type ShopifyProduct } from "./client.ts";
import { ShopifyConnections } from "./connection.ts";

const logger = createLogger("shopify-sync");

/** Where Shopify's stock lands when the business has no single warehouse. */
export const SHOPIFY_LOCATION_NAME = "Shopify";

const statusMap: Record<string, ProductStatus> = {
  active: "active",
  draft: "draft",
  archived: "archived",
};

export type SyncSummary = {
  products: number;
  created: number;
  updated: number;
  failed: number;
};

/**
 * The location Shopify's stock counts at: the business's only location, or
 * its own "Shopify" location when it has several — a guess would hide units
 * in a warehouse nobody watches.
 */
export async function shopifyLocation(
  tenantId: string,
): Promise<StockLocation> {
  const single = await StockService.defaultLocation(tenantId);
  if (single) return single;
  const existing = (await StockService.listLocations(tenantId)).find(
    (location) => location.name === SHOPIFY_LOCATION_NAME,
  );
  return (
    existing ??
    (await StockService.createLocation(tenantId, SHOPIFY_LOCATION_NAME))!
  );
}

/**
 * Sets the variant's on-hand at `locationId` so that what is sellable here —
 * on hand minus what orders hold — equals Shopify's `available`. A move
 * Shopify learned through a VendeYa order writes back already counted, so
 * the reserved units stay part of the level.
 */
export async function applyShopifyAvailable(
  tenantId: string,
  variantId: string,
  locationId: string,
  available: number,
  note: string,
): Promise<void> {
  // The delta rides in the statement: a concurrent delivery computes it
  // from the level at write time, so the last writer lands on `available`
  // and the movements add up to one net change, never a double count.
  const delta = sql<number>`${available} + stock_levels.reserved - stock_levels.on_hand`;
  await batch([
    db.insertInto("stock_levels").orIgnore().values({
      tenant_id: tenantId,
      variant_id: variantId,
      location_id: locationId,
    }),
    db
      .insertInto("stock_movements")
      .columns([
        "id",
        "tenant_id",
        "variant_id",
        "location_id",
        "kind",
        "quantity",
        "note",
        "created_by",
      ])
      .expression(
        db
          .selectFrom("stock_levels")
          .select((eb) => [
            eb.val(newId()).as("id"),
            eb.val(tenantId).as("tenant_id"),
            eb.val(variantId).as("variant_id"),
            eb.val(locationId).as("location_id"),
            eb.val("adjust").as("kind"),
            delta.as("quantity"),
            eb.val(note).as("note"),
            eb.val(null).as("created_by"),
          ])
          .where("tenant_id", "=", tenantId)
          .where("variant_id", "=", variantId)
          .where("location_id", "=", locationId)
          .where(delta, "<>", 0),
      ),
    db
      .updateTable("stock_levels")
      .set((eb) => ({ on_hand: eb("reserved", "+", available) }))
      .where("tenant_id", "=", tenantId)
      .where("variant_id", "=", variantId)
      .where("location_id", "=", locationId),
  ]);
}

/** A Shopify product id as the catalog stores it. */
const shopifyId = (id: number | string): string => String(id);

/** The SKU an imported variant takes: Shopify's, or one keyed by the variant. */
function variantSku(
  sku: string | null,
  shopifyVariantId: string,
  taken: Set<string>,
): string {
  const wanted = sku?.trim() || `S${shopifyVariantId}`;
  return taken.has(wanted) ? `S${shopifyVariantId}` : wanted;
}

/**
 * Upserts one Shopify product and its variants. Keyed by the Shopify ids, so
 * a repeat sync updates the same rows: Shopify wins on name, description,
 * status, price and stock; an SKU or a manual variant stays put.
 * `inventory` maps each inventory item id to its summed `available`.
 */
export async function upsertShopifyProduct(
  tenantId: string,
  product: ShopifyProduct,
  inventory: Map<string, number>,
  locationId: string,
): Promise<"created" | "updated"> {
  const shopifyProductId = shopifyId(product.id);
  const existing = await db
    .selectFrom("products")
    .select("id")
    .where(tenantScope(tenantId))
    .where("shopify_product_id", "=", shopifyProductId)
    .executeTakeFirst();

  const productId = existing?.id ?? newId();
  const fields = {
    name: product.title,
    description: product.body_html
      ? product.body_html
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim() || null
      : null,
    status: statusMap[product.status] ?? "active",
    category: product.product_type?.trim() || "General",
    brand: product.vendor?.trim() || null,
  };
  const statements: Compilable[] = [
    existing
      ? db
          .updateTable("products")
          .set(fields)
          .where("id", "=", productId)
          .where("tenant_id", "=", tenantId)
      : db.insertInto("products").values({
          id: productId,
          tenant_id: tenantId,
          shopify_product_id: shopifyProductId,
          ...fields,
        }),
  ];

  const shopifyVariantIds = product.variants.map((v) => shopifyId(v.id));
  const [existingVariants, takenSkus] = await Promise.all([
    db
      .selectFrom("product_variants")
      .select(["id", "shopify_variant_id", "sku"])
      .where("tenant_id", "=", tenantId)
      .where("product_id", "=", productId)
      .execute(),
    db
      .selectFrom("product_variants")
      .select("sku")
      .where("tenant_id", "=", tenantId)
      .execute(),
  ]);
  const taken = new Set(takenSkus.map((row) => row.sku));
  const byShopifyId = new Map(
    existingVariants.map((v) => [v.shopify_variant_id, v]),
  );

  for (const variant of product.variants) {
    const shopifyVariantId = shopifyId(variant.id);
    const current = byShopifyId.get(shopifyVariantId);
    const name =
      variant.title && variant.title !== "Default Title" ? variant.title : null;
    const price = Math.round(Number(variant.price) * 100);
    const fields = {
      name,
      price_cents: Number.isSafeInteger(price) && price >= 0 ? price : 0,
      is_active:
        (statusMap[product.status] ?? "active") === "archived"
          ? (0 as const)
          : (1 as const),
    };
    if (current) {
      statements.push(
        db
          .updateTable("product_variants")
          .set(fields)
          .where("id", "=", current.id)
          .where("tenant_id", "=", tenantId),
      );
    } else {
      const sku = variantSku(variant.sku, shopifyVariantId, taken);
      taken.add(sku);
      statements.push(
        db.insertInto("product_variants").values({
          id: newId(),
          tenant_id: tenantId,
          product_id: productId,
          shopify_variant_id: shopifyVariantId,
          shopify_inventory_item_id: shopifyId(variant.inventory_item_id),
          sku,
          ...fields,
        }),
      );
    }
  }

  // A variant Shopify no longer sells stays, switched off: its order lines
  // still resolve, but the assistant cannot offer it.
  for (const variant of existingVariants) {
    if (
      variant.shopify_variant_id &&
      !shopifyVariantIds.includes(variant.shopify_variant_id)
    ) {
      statements.push(
        db
          .updateTable("product_variants")
          .set({ is_active: 0 })
          .where("id", "=", variant.id)
          .where("tenant_id", "=", tenantId),
      );
    }
  }

  await batch(statements);

  // Shopify's stock wins for the imported variants, at the Shopify location.
  for (const variant of product.variants) {
    const inventoryItemId = shopifyId(variant.inventory_item_id);
    const available = inventory.get(inventoryItemId);
    if (available === undefined) continue;
    const ours = await db
      .selectFrom("product_variants")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("shopify_variant_id", "=", shopifyId(variant.id))
      .executeTakeFirst();
    if (!ours) continue;
    await applyShopifyAvailable(
      tenantId,
      ours.id,
      locationId,
      available,
      "Sincronización Shopify",
    );
  }

  if (product.image) {
    // The product's rows already committed; a photo that will not download
    // or store must not fail a product that imported fine.
    try {
      await syncMainImage(tenantId, productId, product.image);
    } catch (error) {
      logger.warn(
        { error, tenantId, productId, src: product.image.src },
        "Shopify product photo failed to import",
      );
    }
  }
  return existing ? "updated" : "created";
}

/**
 * The product's main photo, stored like an uploaded one and marked with its
 * Shopify image id. A later sync with the same id keeps it; a new one
 * replaces the earlier import, and photos the owner added stay.
 */
async function syncMainImage(
  tenantId: string,
  productId: string,
  image: { id: number; src: string },
): Promise<void> {
  const shopifyImageId = String(image.id);
  const current = await db
    .selectFrom("product_images")
    .select(["id", "shopify_image_id", "position"])
    .where("tenant_id", "=", tenantId)
    .where("product_id", "=", productId)
    .where("shopify_image_id", "is not", null)
    .executeTakeFirst();
  if (current?.shopify_image_id === shopifyImageId) return;

  const { bytes, contentType } = await ShopifyApi.download(image.src);
  let imageId: string;
  let byteSize = bytes.length;
  let storedType = "image/jpeg";
  try {
    ({ imageId, byteSize } = await imageStorage.store(tenantId, bytes));
  } catch (error) {
    // The optimize binding is absent under tests; there the raw bytes go in
    // under their own type. Elsewhere an optimize failure is logged and the
    // unoptimized photo is still kept.
    logger.warn(
      { error, tenantId, src: image.src },
      "Product photo stored without optimization",
    );
    if (!contentType.startsWith("image/")) throw error;
    storedType = contentType;
    imageId = newId().replace(/-/g, "").slice(0, 16);
    await imageStorage.put(tenantId, imageId, bytes);
  }

  const assetId = newId();
  const rowId = newId();
  const statements: Compilable[] = [
    db.insertInto("assets").values({
      id: assetId,
      tenant_id: tenantId,
      kind: "catalog_image",
      visibility: "public",
      storage_key: imageStorage.storageKey(tenantId, imageId),
      content_type: storedType,
      byte_size: byteSize,
      created_by: null,
    }),
    db.insertInto("product_images").values({
      id: rowId,
      tenant_id: tenantId,
      product_id: productId,
      asset_id: assetId,
      position: 0,
      shopify_image_id: shopifyImageId,
    }),
    // The imported photo covers the product.
    db
      .updateTable("product_images")
      .set((eb) => ({ position: eb("position", "+", 1) }))
      .where("tenant_id", "=", tenantId)
      .where("product_id", "=", productId)
      .where("id", "!=", rowId),
  ];
  if (current) {
    statements.push(
      db
        .deleteFrom("product_images")
        .where("id", "=", current.id)
        .where("tenant_id", "=", tenantId),
    );
  }
  await batch(statements);
}

/**
 * Brings the whole store into the catalog: products, variants, prices, stock
 * and each product's main photo. Re-running updates the same rows.
 */
export async function syncFromShopify(tenantId: string): Promise<SyncSummary> {
  const login = await ShopifyConnections.login(tenantId);
  if (!login) throw new Error("Shopify is not connected");

  const location = await shopifyLocation(tenantId);
  const summary: SyncSummary = {
    products: 0,
    created: 0,
    updated: 0,
    failed: 0,
  };

  let sinceId = 0;
  for (;;) {
    const products = await ShopifyApi.products(login, sinceId);
    if (products.length === 0) break;
    sinceId = Math.max(...products.map((p) => p.id));

    const itemIds = products.flatMap((p) =>
      p.variants.map((v) => shopifyId(v.inventory_item_id)),
    );
    const inventory = new Map<string, number>();
    for (let i = 0; i < itemIds.length; i += 50) {
      for (const level of await ShopifyApi.inventoryLevels(
        login,
        itemIds.slice(i, i + 50),
      )) {
        const key = shopifyId(level.inventory_item_id);
        inventory.set(key, (inventory.get(key) ?? 0) + level.available);
      }
    }

    for (const product of products) {
      try {
        const outcome = await upsertShopifyProduct(
          tenantId,
          product,
          inventory,
          location.id,
        );
        summary[outcome === "created" ? "created" : "updated"] += 1;
      } catch (error) {
        summary.failed += 1;
        logger.error(
          { error, tenantId, shopifyProductId: product.id },
          "Shopify product failed to sync",
        );
      }
      summary.products += 1;
    }
    if (products.length < 250) break;
  }

  // A partial import keeps its earlier sync time: reporting a fresh one
  // would tell the shop everything came over.
  if (summary.failed === 0) {
    await ShopifyConnections.markSynced(tenantId, Date.now());
  }
  return summary;
}
