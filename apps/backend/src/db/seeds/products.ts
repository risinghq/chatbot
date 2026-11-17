import { tenantScopedId } from "../../domains/catalog/ids.ts";
import { batch, getOne, stmt } from "../index.ts";
import { BASE_PRODUCTS } from "../seed-data/products.ts";

export async function seedProducts(tenantId: string) {
  const exists = await getOne(
    "SELECT 1 FROM products WHERE tenant_id = ? LIMIT 1",
    [tenantId],
  );
  if (exists) return;

  await batch(
    BASE_PRODUCTS.map((product) =>
      stmt(
        `INSERT INTO products (id, tenant_id, name, category, brand, model, specs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          // The base catalog's ids are shared by every tenant seeded from it,
          // so they are scoped to this one before they reach the global
          // primary key.
          tenantScopedId(tenantId, product.id),
          tenantId,
          product.name,
          product.category,
          product.brand,
          product.model,
          JSON.stringify(product.specs),
        ],
      ),
    ),
  );
}
