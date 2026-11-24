import type { StockRow } from "@vendeya/types";
import { db } from "../../../db/index.ts";
import { ProductImageService } from "../../catalog/images.ts";
import {
  DeliveryZoneService,
  PaymentMethodService,
} from "../../orders/index.ts";
import { TAYPI_ASSISTANT_METHOD } from "../../payments/charges.ts";
import { taypiKeys } from "../../payments/taypi.ts";
import { StockService } from "../../stock/index.ts";
import { AssistantSettingsService } from "../settings.ts";
import { optionalText, soles, text } from "./args.ts";
import { answer, type Tool } from "./types.ts";

/** Most products one search returns, so a broad query stays a short reply. */
const SEARCH_LIMIT = 8;
/** Most photos one call sends to the customer. */
const PHOTO_LIMIT = 3;

/**
 * The location the assistant sells from: the one its settings name, or the
 * business's only one. Undefined when the business has several and named
 * none; stock is then summed over all of them and an order cannot be taken.
 */
export async function assistantLocation(
  tenantId: string,
): Promise<string | undefined> {
  const settings = await AssistantSettingsService.get(tenantId);
  if (settings.stock_location_id) return settings.stock_location_id;
  return (await StockService.defaultLocation(tenantId))?.id;
}

function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function stockFor(
  tenantId: string,
  productIds: string[],
): Promise<StockRow[]> {
  const location = await assistantLocation(tenantId);
  const rows = await StockService.levels(tenantId, location, productIds);
  return rows.filter((r) => r.is_active);
}

const searchProducts: Tool = {
  name: "search_products",
  description:
    "Search the catalog by words in the product's name, brand, model, " +
    "category or description. Pass null to list products. Returns at most " +
    `${SEARCH_LIMIT} products for sale, each with its lowest price and ` +
    "whether any unit is available.",
  parameters: {
    type: "object",
    properties: { query: { type: ["string", "null"] } },
    required: ["query"],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const words = (optionalText(args, "query") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `%${escapeLike(w)}%`);
    let query = db
      .selectFrom("products")
      .select(["id", "name", "brand", "category", "description"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("status", "=", "active");
    for (const word of words) {
      query = query.where((eb) =>
        eb.or(
          (["name", "brand", "model", "category", "description"] as const).map(
            (column) => eb(column, "like", eb.val(word)),
          ),
        ),
      );
    }
    // Products are filtered to those with a variant for sale after the read,
    // so the read takes more than it returns.
    const products = await query
      .orderBy("name")
      .limit(SEARCH_LIMIT * 3)
      .execute();
    const stock = await stockFor(
      ctx.tenantId,
      products.map((p) => p.id),
    );
    const found = products.flatMap((p) => {
      const variants = stock.filter((s) => s.product_id === p.id);
      if (variants.length === 0) return [];
      return [
        {
          product_id: p.id,
          name: p.name,
          brand: p.brand,
          category: p.category,
          description: p.description?.slice(0, 300) ?? null,
          price_from: soles(Math.min(...variants.map((v) => v.price_cents))),
          available: variants.some((v) => v.available > 0),
        },
      ];
    });
    return answer({ products: found.slice(0, SEARCH_LIMIT) });
  },
};

const getProduct: Tool = {
  name: "get_product",
  description:
    "Read one product: its description, how many photos it has, and each " +
    "variant for sale with its id, name, price, the units available now and " +
    "whether it has photos of its own.",
  parameters: {
    type: "object",
    properties: { product_id: { type: "string" } },
    required: ["product_id"],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const id = text(args, "product_id");
    const product = await db
      .selectFrom("products")
      .select(["id", "name", "brand", "model", "category", "description"])
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!product) return answer({ error: "product not found" });
    const [stock, photos] = await Promise.all([
      stockFor(ctx.tenantId, [id]),
      ProductImageService.list(ctx.tenantId, id),
    ]);
    return answer({
      ...product,
      photos: photos.length,
      variants: stock.map((v) => ({
        variant_id: v.variant_id,
        name: v.variant_name,
        sku: v.sku,
        price: soles(v.price_cents),
        available: Math.max(0, v.available),
        own_photos: photos.some((p) => p.variant_ids.includes(v.variant_id)),
      })),
    });
  },
};

const sendProductPhotos: Tool = {
  name: "send_product_photos",
  description:
    `Send the customer up to ${PHOTO_LIMIT} photos of a product, after your ` +
    "reply. Pass variant_id when the customer asks about one variant: its own " +
    "photos go first, then those of the whole product, and never photos of " +
    "other variants. Pass null for photos of the product as a whole.",
  parameters: {
    type: "object",
    properties: {
      product_id: { type: "string" },
      variant_id: { type: ["string", "null"] },
    },
    required: ["product_id", "variant_id"],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const id = text(args, "product_id");
    const variantId = optionalText(args, "variant_id") ?? undefined;
    const product = await db
      .selectFrom("products")
      .select("name")
      .where("tenant_id", "=", ctx.tenantId)
      .where("id", "=", id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!product) return answer({ error: "product not found" });
    const storageKeys = await ProductImageService.storageKeys(
      ctx.tenantId,
      id,
      PHOTO_LIMIT,
      variantId,
    );
    if (storageKeys.length === 0)
      return answer({ error: "the product has no photos" });
    return answer({ photos_sent: storageKeys.length }, [
      {
        kind: "send_photos",
        productId: id,
        productName: product.name,
        storageKeys,
      },
    ]);
  },
};

const listDeliveryZones: Tool = {
  name: "list_delivery_zones",
  description:
    "The zones the business delivers to and the fee of each. An address " +
    "outside them is a pickup or a question for staff.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  run: async (ctx) => {
    const zones = await DeliveryZoneService.list(ctx.tenantId);
    return answer({
      zones: zones
        .filter((z) => z.is_active)
        .map((z) => ({ zone_id: z.id, name: z.name, fee: soles(z.fee_cents) })),
    });
  },
};

const listPaymentMethods: Tool = {
  name: "list_payment_methods",
  description:
    "The ways the business takes payment, each with what to tell the customer.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  run: async (ctx) => {
    const methods = await PaymentMethodService.list(ctx.tenantId);
    const offered = methods
      .filter((m) => m.is_active)
      .map((m) => ({
        payment_method_id: m.id,
        name: m.name,
        instructions: m.instructions,
      }));
    if (await taypiKeys(ctx.tenantId)) {
      offered.unshift({
        payment_method_id: TAYPI_ASSISTANT_METHOD.id,
        name: TAYPI_ASSISTANT_METHOD.name,
        instructions: TAYPI_ASSISTANT_METHOD.instructions,
      });
    }
    return answer({ payment_methods: offered });
  },
};

export const catalogTools = [
  searchProducts,
  getProduct,
  sendProductPhotos,
  listDeliveryZones,
  listPaymentMethods,
];
