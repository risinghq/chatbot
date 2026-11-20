import type { ProductVariant } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import type { Binding } from "../../db/index.ts";
import { getAll, getOne, run } from "../../db/index.ts";
import { isConstraintError } from "../../db/constraints.ts";

export type VariantFields = {
  name: string | null;
  sku: string;
  price_cents: number;
  cost_cents: number | null;
  is_active: 0 | 1;
};

/** A write that names a SKU another variant of the business already uses. */
export class DuplicateSkuError extends Error {
  constructor(readonly sku: string) {
    super(`SKU ${sku} is already used by another variant`);
  }
}

const NON_NEGATIVE_INTEGER = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The fields of a create (`partial` false) or an update (`partial` true), or
 * the reason the body is refused. A SKU is trimmed and cannot be empty.
 */
export function parseVariantFields(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<VariantFields> | string {
  const fields: Partial<VariantFields> = {};

  if (body.sku !== undefined || !partial) {
    if (typeof body.sku !== "string" || body.sku.trim() === "") {
      return "sku must be a non-empty string";
    }
    fields.sku = body.sku.trim();
  }
  if (body.price_cents !== undefined || !partial) {
    if (!NON_NEGATIVE_INTEGER(body.price_cents)) {
      return "price_cents must be a whole number of 0 or more";
    }
    fields.price_cents = body.price_cents;
  }
  if (body.cost_cents !== undefined) {
    if (body.cost_cents !== null && !NON_NEGATIVE_INTEGER(body.cost_cents)) {
      return "cost_cents must be null or a whole number of 0 or more";
    }
    fields.cost_cents = body.cost_cents;
  }
  if (body.name !== undefined) {
    if (body.name !== null && typeof body.name !== "string") {
      return "name must be a string or null";
    }
    fields.name = body.name?.trim() || null;
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return "is_active must be a boolean";
    }
    fields.is_active = body.is_active ? 1 : 0;
  }
  return fields;
}

export const VariantService = {
  listByProduct: async (
    tenantId: string,
    productId: string,
  ): Promise<ProductVariant[]> =>
    await getAll<ProductVariant>(
      `SELECT * FROM product_variants
       WHERE tenant_id = ? AND product_id = ?
       ORDER BY id`,
      [tenantId, productId],
    ),

  getById: async (
    tenantId: string,
    id: string,
  ): Promise<ProductVariant | null> =>
    (await getOne<ProductVariant>(
      `SELECT * FROM product_variants WHERE id = ? AND tenant_id = ?`,
      [id, tenantId],
    )) ?? null,

  getBySku: async (
    tenantId: string,
    sku: string,
  ): Promise<ProductVariant | null> =>
    (await getOne<ProductVariant>(
      `SELECT * FROM product_variants WHERE sku = ? AND tenant_id = ?`,
      [sku, tenantId],
    )) ?? null,

  /** Throws `DuplicateSkuError` when the SKU is taken. */
  create: async (
    tenantId: string,
    productId: string,
    fields: VariantFields,
  ): Promise<ProductVariant> => {
    const id = newId();
    await withSkuCheck(fields.sku, () =>
      run(
        `INSERT INTO product_variants
           (id, tenant_id, product_id, name, sku, price_cents, cost_cents, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          productId,
          fields.name,
          fields.sku,
          fields.price_cents,
          fields.cost_cents,
          fields.is_active,
        ],
      ),
    );
    return (await VariantService.getById(tenantId, id))!;
  },

  /** Throws `DuplicateSkuError` when the new SKU is taken. */
  update: async (
    tenantId: string,
    id: string,
    fields: Partial<VariantFields>,
  ): Promise<ProductVariant | null> => {
    const entries = Object.entries(fields) as [keyof VariantFields, Binding][];
    if (entries.length > 0) {
      await withSkuCheck(fields.sku ?? "", () =>
        run(
          `UPDATE product_variants
           SET ${entries.map(([column]) => `${column} = ?`).join(", ")}
           WHERE id = ? AND tenant_id = ?`,
          [...entries.map(([, value]) => value), id, tenantId],
        ),
      );
    }
    return await VariantService.getById(tenantId, id);
  },
};

async function withSkuCheck<T>(
  sku: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isConstraintError(error, "UNIQUE")) throw new DuplicateSkuError(sku);
    throw error;
  }
}
