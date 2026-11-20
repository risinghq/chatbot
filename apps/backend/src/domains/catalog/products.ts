import { tenantPredicate } from "../../db/query.ts";
import type { Product, ProductStatus } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { mediaPath } from "../../lib/storage-paths.ts";
import type { Binding } from "../../db/index.ts";
import { getAll, getOne, run } from "../../db/index.ts";

/**
 * `tenantId` null reads across tenants (platform operators only). Writes always
 * take a concrete tenant.
 */
export const ProductService = {
  getAll: async (tenantId: string | null): Promise<Product[]> => {
    const rows = await getAll<Product & { cover_key: string | null }>(
      `SELECT p.*,
              (SELECT COUNT(*) FROM product_variants v
               WHERE v.product_id = p.id AND v.tenant_id = p.tenant_id) AS variant_count,
              (SELECT a.storage_key
               FROM product_images i JOIN assets a
                 ON a.id = i.asset_id AND a.tenant_id = i.tenant_id
               WHERE i.product_id = p.id AND i.tenant_id = p.tenant_id
               ORDER BY i.position, i.id LIMIT 1) AS cover_key
       FROM products p WHERE ${tenantPredicate(tenantId, "p.tenant_id")}
       ORDER BY p.category, p.name`,
      tenantId ? [tenantId] : [],
    );
    return rows.map(({ cover_key, ...product }) => ({
      ...product,
      cover_url: cover_key ? mediaPath(cover_key) : null,
    }));
  },

  getByCategory: async (
    tenantId: string | null,
    category: string,
  ): Promise<Product[]> =>
    await getAll<Product>(
      `SELECT * FROM products WHERE category = ? AND ${tenantPredicate(tenantId)}
       ORDER BY name`,
      tenantId ? [category, tenantId] : [category],
    ),

  getById: async (
    tenantId: string | null,
    id: string,
  ): Promise<Product | null> =>
    (await getOne<Product>(
      `SELECT * FROM products WHERE id = ? AND ${tenantPredicate(tenantId)}`,
      tenantId ? [id, tenantId] : [id],
    )) ?? null,

  create: async (data: {
    tenantId: string;
    name: string;
    category: string;
    description?: string;
    status?: ProductStatus;
    brand?: string;
    model?: string;
    specs_json?: string;
  }): Promise<Product> => {
    const id = newId();
    await run(
      `INSERT INTO products
         (id, tenant_id, name, description, status, category, brand, model, specs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.tenantId,
        data.name,
        data.description || null,
        data.status ?? "active",
        data.category,
        data.brand || null,
        data.model || null,
        data.specs_json || null,
      ],
    );
    return (await ProductService.getById(data.tenantId, id))!;
  },

  update: async (
    tenantId: string,
    id: string,
    data: Partial<Product>,
  ): Promise<Product | null> => {
    const fields: string[] = [];
    const values: Binding[] = [];

    if (data.name !== undefined) {
      fields.push("name = ?");
      values.push(data.name);
    }
    if (data.description !== undefined) {
      fields.push("description = ?");
      values.push(data.description);
    }
    if (data.status !== undefined) {
      fields.push("status = ?");
      values.push(data.status);
    }
    if (data.category !== undefined) {
      fields.push("category = ?");
      values.push(data.category);
    }
    if (data.brand !== undefined) {
      fields.push("brand = ?");
      values.push(data.brand);
    }
    if (data.model !== undefined) {
      fields.push("model = ?");
      values.push(data.model);
    }
    if (data.specs_json !== undefined) {
      fields.push("specs_json = ?");
      values.push(data.specs_json);
    }

    if (fields.length === 0) return await ProductService.getById(tenantId, id);

    values.push(id, tenantId);
    await run(
      `UPDATE products SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`,
      values,
    );
    return await ProductService.getById(tenantId, id);
  },

  getCategories: async (tenantId: string | null): Promise<string[]> => {
    const rows = await getAll<{ category: string }>(
      `SELECT DISTINCT category FROM products
       WHERE ${tenantPredicate(tenantId)}
       ORDER BY category`,
      tenantId ? [tenantId] : [],
    );
    return rows.map((r) => r.category);
  },

  /**
   * Get active categories for a segment based on available bundles
   * Only returns categories that have active, in-stock bundles
   */
  getActiveCategoriesBySegment: async (
    tenantId: string,
    segment: "fnb" | "gaso",
  ): Promise<string[]> => {
    const rows = await getAll<{ category: string }>(
      `SELECT DISTINCT b.primary_category as category
       FROM catalog_bundles b
       JOIN catalog_periods p ON b.period_id = p.id AND p.tenant_id = b.tenant_id
       WHERE b.tenant_id = ?
         AND p.status = 'active'
         AND b.is_active = 1
         AND b.stock_status != 'out_of_stock'
         AND b.segment = ?
       ORDER BY b.primary_category`,
      [tenantId, segment],
    );
    return rows.map((r) => r.category);
  },

  /**
   * Get all active brands from products involved in active, in-stock bundles.
   */
  getActiveBrands: async (tenantId: string): Promise<string[]> => {
    const rows = await getAll<{ brand: string }>(
      `SELECT DISTINCT p.brand
       FROM catalog_bundles b
       JOIN catalog_periods p_desc ON b.period_id = p_desc.id AND p_desc.tenant_id = b.tenant_id,
            json_tree(b.composition_json) as ref
       JOIN products p ON p.id = ref.value AND p.tenant_id = b.tenant_id
       WHERE b.tenant_id = ?
         AND p_desc.status = 'active'
         AND b.is_active = 1
         AND b.stock_status != 'out_of_stock'
         AND ref.key = 'id'
         AND p.brand IS NOT NULL
         AND p.brand != ''
       ORDER BY p.brand`,
      [tenantId],
    );
    return rows.map((r) => r.brand);
  },
};
