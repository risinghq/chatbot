import { tenantPredicate } from "../../db/query.ts";
import type { Binding } from "../../db/index.ts";
import type { Bundle } from "@vendeya/types";
import { imageStorage } from "../../adapters/storage/images.ts";
import { AssetService } from "../assets/index.ts";
import { getAll, getOne, run } from "../../db/index.ts";

/**
 * Drop a bundle's claim on its image. The asset row and the object both live
 * under this tenant. The object goes only with the tenant's last reference to
 * it. `bundleId` still holds its old `image_id` when this runs, so the count of
 * references excludes it.
 */
async function releaseImage(
  tenantId: string,
  bundleId: string,
  imageId: string,
): Promise<void> {
  await AssetService.deleteByStorageKey(
    tenantId,
    imageStorage.storageKey(tenantId, imageId),
  );

  const others = await getOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM catalog_bundles
     WHERE tenant_id = ? AND image_id = ? AND id != ?`,
    [tenantId, imageId, bundleId],
  );

  if ((others?.count ?? 0) > 0) return;

  await imageStorage.delete(tenantId, imageId);
}

const REQUIRED_TEXT_FIELDS = [
  "name",
  "primary_category",
  "composition_json",
  "installments_json",
] as const;

const JSON_FIELDS = ["composition_json", "installments_json"] as const;

export const STOCK_STATUSES = [
  "in_stock",
  "low_stock",
  "out_of_stock",
] as const;

/**
 * Why an edit to a bundle cannot be stored, or null when the fields given are
 * fine. A field left out is not checked, and a key that is not an editable
 * column is ignored, as `update` ignores it. Each rule mirrors the column it
 * guards, so a refusal here is a 400 instead of a CHECK failure. Both JSON
 * columns are parsed on every catalog read (`json_tree`, the image caption), so
 * a value that does not parse would break the bot's replies.
 */
export function bundleFieldsError(fields: {
  name?: unknown;
  price?: unknown;
  is_active?: unknown;
  stock_status?: unknown;
  notes?: unknown;
  primary_category?: unknown;
  composition_json?: unknown;
  installments_json?: unknown;
}): string | null {
  for (const key of REQUIRED_TEXT_FIELDS) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      return `${key} must be a non-empty string`;
    }
  }

  const { price, is_active, stock_status, notes } = fields;
  if (
    price !== undefined &&
    (typeof price !== "number" || !Number.isFinite(price) || price <= 0)
  ) {
    return "price must be a number above zero";
  }
  if (is_active !== undefined && is_active !== 0 && is_active !== 1) {
    return "is_active must be 0 or 1";
  }
  if (
    stock_status !== undefined &&
    !(STOCK_STATUSES as readonly unknown[]).includes(stock_status)
  ) {
    return `stock_status must be one of ${STOCK_STATUSES.join(", ")}`;
  }
  if (notes !== undefined && typeof notes !== "string") {
    return "notes must be a string";
  }

  for (const key of JSON_FIELDS) {
    const value = fields[key];
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value);
      if (parsed === null || typeof parsed !== "object") {
        return `${key} must be a JSON object or array`;
      }
    } catch {
      return `${key} must be valid JSON`;
    }
  }

  return null;
}

type BundleFilters = {
  periodId?: string;
  maxPrice?: number;
  category?: string;
  strictPriceLimit?: boolean;
  offset?: number;
  query?: string;
  segment?: "gaso" | "fnb";
};

/**
 * Every read takes the tenant whose catalog is being read. `getByPeriod` and
 * `getById` also accept null for the cross-tenant read, which an unpinned
 * platform operator reaches through the catalog routes.
 */
export const BundleService = {
  /** Get all bundles for a period (dashboard) */
  getByPeriod: async (
    tenantId: string | null,
    periodId: string,
    segment?: "gaso" | "fnb",
  ): Promise<Bundle[]> => {
    const params: Binding[] = [periodId];
    let sql = "SELECT * FROM catalog_bundles WHERE period_id = ?";

    sql += ` AND ${tenantPredicate(tenantId)}`;
    if (tenantId) params.push(tenantId);
    if (segment) {
      sql += " AND segment = ?";
      params.push(segment);
    }

    sql += " ORDER BY primary_category, price";
    return await getAll<Bundle>(sql, params);
  },

  /** Get available bundles for bot (active period, filters) */
  getAvailable: async (
    tenantId: string,
    filters: BundleFilters = {},
  ): Promise<Bundle[]> => {
    let query = `
      SELECT b.* FROM catalog_bundles b
      JOIN catalog_periods p ON b.period_id = p.id AND p.tenant_id = b.tenant_id
      WHERE b.tenant_id = ?
        AND p.status = 'active'
        AND b.is_active = 1
        AND b.stock_status != 'out_of_stock'
    `;
    const params: Binding[] = [tenantId];

    if (filters.segment) {
      query += " AND b.segment = ?";
      params.push(filters.segment);
    }

    if (filters.strictPriceLimit && filters.maxPrice !== undefined) {
      query += " AND b.price <= ?";
      params.push(filters.maxPrice);
    }

    if (filters.category) {
      // Match primary_category OR any category in categories_json
      query += " AND (b.primary_category = ? OR b.categories_json LIKE ?)";
      params.push(filters.category, `%"${filters.category}"%`);
    }

    if (filters.query) {
      query += " AND b.name LIKE ?";
      params.push(`%${filters.query}%`);
    }

    query += " ORDER BY b.price ASC";
    query += " LIMIT 3";

    if (filters.offset) {
      query += " OFFSET ?";
      params.push(filters.offset);
    }

    const rows = await getAll<Bundle>(query, params);
    return rows;
  },

  getById: async (
    tenantId: string | null,
    id: string,
  ): Promise<Bundle | null> =>
    (await getOne<Bundle>(
      `SELECT * FROM catalog_bundles WHERE id = ? AND ${tenantPredicate(tenantId)}`,
      tenantId ? [id, tenantId] : [id],
    )) ?? null,

  create: async (data: {
    id: string;
    tenantId: string;
    period_id: string;
    segment: "gaso" | "fnb";
    name: string;
    price: number;
    primary_category: string;
    categories_json: string;
    image_id: string;
    composition_json: string;
    installments_json: string;
    notes?: string;
    created_by: string | null;
  }): Promise<Bundle> => {
    await run(
      `
      INSERT INTO catalog_bundles (id, tenant_id, period_id, segment, name, price, primary_category, categories_json, image_id, composition_json, installments_json, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        data.id,
        data.tenantId,
        data.period_id,
        data.segment,
        data.name,
        data.price,
        data.primary_category,
        data.categories_json,
        data.image_id,
        data.composition_json,
        data.installments_json,
        data.notes ||
          "01 año de garantía, delivery gratuito, cero cuota inicial",
        data.created_by,
      ],
    );
    return (await BundleService.getById(data.tenantId, data.id))!;
  },

  /**
   * Editable bundle fields, one `if` per column. Unknown keys are ignored, not
   * rejected. The type is the contract and this list is the enforcement. The
   * caller checks every field with `bundleFieldsError` first.
   */
  update: async (
    tenantId: string,
    id: string,
    updates: Partial<
      Pick<
        Bundle,
        | "name"
        | "price"
        | "is_active"
        | "stock_status"
        | "notes"
        | "primary_category"
        | "composition_json"
        | "installments_json"
      >
    >,
  ): Promise<Bundle | null> => {
    const data = updates ?? {};
    // Callers hand this raw request bodies, so `tenant_id` must not reach the
    // SET clause. The WHERE still matches on the row's current tenant, so a
    // body that carried it would hand the row to another business.
    const fields: string[] = [];
    const values: Binding[] = [];

    if (data.name !== undefined) {
      fields.push("name = ?");
      values.push(data.name);
    }
    if (data.price !== undefined) {
      fields.push("price = ?");
      values.push(data.price);
    }
    if (data.is_active !== undefined) {
      fields.push("is_active = ?");
      values.push(data.is_active);
    }
    if (data.stock_status !== undefined) {
      fields.push("stock_status = ?");
      values.push(data.stock_status);
    }
    if (data.notes !== undefined) {
      fields.push("notes = ?");
      values.push(data.notes);
    }
    if (data.primary_category !== undefined) {
      fields.push("primary_category = ?");
      values.push(data.primary_category);
    }
    if (data.composition_json !== undefined) {
      fields.push("composition_json = ?");
      values.push(data.composition_json);
    }
    if (data.installments_json !== undefined) {
      fields.push("installments_json = ?");
      values.push(data.installments_json);
    }

    if (fields.length === 0) return await BundleService.getById(tenantId, id);

    await run(
      `UPDATE catalog_bundles SET ${fields.join(", ")}, updated_at = unixepoch('now', 'subsec') * 1000
       WHERE id = ? AND tenant_id = ?`,
      [...values, id, tenantId],
    );
    return await BundleService.getById(tenantId, id);
  },

  /** Same allowlist rule as `update`, applied to every id in the batch. */
  bulkUpdate: async (
    tenantId: string,
    ids: string[],
    updates: Partial<Pick<Bundle, "is_active" | "stock_status">>,
  ): Promise<number> => {
    const data = updates ?? {};
    const fields: string[] = [];
    const values: Binding[] = [];

    if (data.is_active !== undefined) {
      fields.push("is_active = ?");
      values.push(data.is_active);
    }
    if (data.stock_status !== undefined) {
      fields.push("stock_status = ?");
      values.push(data.stock_status);
    }

    if (fields.length === 0 || ids.length === 0) return 0;

    const placeholders = ids.map(() => "?").join(",");

    const result = await run(
      `UPDATE catalog_bundles SET ${fields.join(", ")}, updated_at = unixepoch('now', 'subsec') * 1000
         WHERE tenant_id = ? AND id IN (${placeholders})`,
      [...values, tenantId, ...ids],
    );
    return result.changes;
  },

  updateImage: async (
    tenantId: string,
    id: string,
    newImageId: string,
  ): Promise<Bundle> => {
    const existing = await BundleService.getById(tenantId, id);
    if (!existing) throw new Error("Bundle not found");

    await releaseImage(tenantId, id, existing.image_id);

    await run(
      `UPDATE catalog_bundles SET image_id = ?, updated_at = unixepoch('now', 'subsec') * 1000
       WHERE id = ? AND tenant_id = ?`,
      [newImageId, id, tenantId],
    );
    return (await BundleService.getById(tenantId, id))!;
  },

  delete: async (tenantId: string, id: string): Promise<void> => {
    const bundle = await BundleService.getById(tenantId, id);
    if (bundle) {
      await releaseImage(tenantId, id, bundle.image_id);
    }
    await run("DELETE FROM catalog_bundles WHERE id = ? AND tenant_id = ?", [
      id,
      tenantId,
    ]);
  },

  getAvailableCategories: async (
    tenantId: string,
    segment?: "gaso" | "fnb",
  ): Promise<string[]> => {
    const params: Binding[] = [tenantId];
    let sql = `SELECT DISTINCT b.primary_category as category FROM catalog_bundles b
       JOIN catalog_periods p ON b.period_id = p.id AND p.tenant_id = b.tenant_id
       WHERE b.tenant_id = ? AND p.status = 'active' AND b.is_active = 1
         AND b.stock_status != 'out_of_stock'`;

    if (segment) {
      sql += " AND b.segment = ?";
      params.push(segment);
    }

    sql += " ORDER BY b.primary_category";

    return (await getAll<{ category: string }>(sql, params)).map(
      (r) => r.category,
    );
  },

  getAffordableCategories: async (
    tenantId: string,
    segment: "gaso" | "fnb",
    creditLine: number,
  ): Promise<string[]> => {
    const rows = await getAll<{ category: string }>(
      `SELECT DISTINCT b.primary_category as category FROM catalog_bundles b
       JOIN catalog_periods p ON b.period_id = p.id AND p.tenant_id = b.tenant_id
       WHERE b.tenant_id = ?
         AND p.status = 'active' AND b.is_active = 1 AND b.stock_status != 'out_of_stock'
         AND b.segment = ?
         ${segment === "gaso" ? "AND b.price <= ?" : ""}
       ORDER BY b.primary_category`,
      segment === "gaso"
        ? [tenantId, segment, creditLine]
        : [tenantId, segment],
    );
    return rows.map((r) => r.category);
  },

  /**
   * Get ALL categories that exist in the bundles table (taxonomy),
   * regardless of whether they are currently active or in stock.
   * Used for "We don't have that right now" vs "We never have that" distinction.
   */
  getAllCategories: async (tenantId: string): Promise<string[]> => {
    const rows = await getAll<{ category: string }>(
      `SELECT DISTINCT primary_category as category FROM catalog_bundles
       WHERE tenant_id = ? ORDER BY primary_category`,
      [tenantId],
    );
    return rows.map((r) => r.category);
  },

  /**
   * Check if a specific product exists in the active catalog for a category.
   */
  hasProduct: async (
    tenantId: string,
    category: string,
    productQuery: string,
  ): Promise<boolean> => {
    const row = await getOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM catalog_bundles b
       JOIN catalog_periods p ON b.period_id = p.id AND p.tenant_id = b.tenant_id
       WHERE b.tenant_id = ?
         AND p.status = 'active'
         AND b.is_active = 1
         AND b.stock_status != 'out_of_stock'
         AND b.primary_category = ?
         AND b.name LIKE ?`,
      [tenantId, category, `%${productQuery}%`],
    );
    return (row?.count || 0) > 0;
  },
};
