import { ProductService } from "../../domains/catalog/products.ts";
import { VariantService } from "../../domains/catalog/variants.ts";
import { StockService } from "../../domains/stock/index.ts";
import { getOne } from "../index.ts";
import { DEMO_PRODUCTS } from "../seed-data/products.ts";

/** Units of each demo product received into the default location. */
const DEMO_STOCK = 10;

/**
 * Loads the demo catalog: each product, its one variant and its opening stock.
 * A business that already has products is left alone.
 */
export async function seedProducts(tenantId: string): Promise<void> {
  const exists = await getOne(
    "SELECT 1 FROM products WHERE tenant_id = ? LIMIT 1",
    [tenantId],
  );
  if (exists) return;

  const location = await StockService.defaultLocation(tenantId);
  if (!location) throw new Error(`Tenant ${tenantId} has no single location.`);

  for (const demo of DEMO_PRODUCTS) {
    const product = await ProductService.create({
      tenantId,
      name: demo.name,
      category: demo.category,
      brand: demo.brand,
      model: demo.model,
      specs_json: JSON.stringify(demo.specs),
    });
    const variant = await VariantService.create(tenantId, product.id, {
      name: null,
      sku: demo.sku,
      price_cents: demo.price_cents,
      cost_cents: null,
      is_active: 1,
    });
    await StockService.record({
      tenantId,
      variantId: variant.id,
      locationId: location.id,
      kind: "receive",
      quantity: DEMO_STOCK,
      createdBy: null,
    });
  }
}
