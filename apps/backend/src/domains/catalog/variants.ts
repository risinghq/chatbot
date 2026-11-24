import type { ProductVariant } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { db } from "../../db/index.ts";
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
 * the reason the body is refused. A SKU is trimmed. A create may leave it out
 * or empty, and `VariantService.create` makes one; an update cannot empty it.
 */
export function parseVariantFields(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<VariantFields> | string {
  const fields: Partial<VariantFields> = {};

  if (body.sku !== undefined && body.sku !== null) {
    if (typeof body.sku !== "string") return "sku must be a string";
    const sku = body.sku.trim();
    if (sku === "" && partial) return "sku must be a non-empty string";
    if (sku !== "") fields.sku = sku;
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
    await db
      .selectFrom("product_variants")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("product_id", "=", productId)
      .orderBy("id")
      .execute(),

  getById: async (
    tenantId: string,
    id: string,
  ): Promise<ProductVariant | null> =>
    (await db
      .selectFrom("product_variants")
      .selectAll()
      .where("id", "=", id)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst()) ?? null,

  getBySku: async (
    tenantId: string,
    sku: string,
  ): Promise<ProductVariant | null> =>
    (await db
      .selectFrom("product_variants")
      .selectAll()
      .where("sku", "=", sku)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst()) ?? null,

  /**
   * Without a SKU the variant gets the random tail of its id, so an owner who
   * keeps no codes never has to invent one. Throws `DuplicateSkuError` when
   * the SKU is taken.
   */
  create: async (
    tenantId: string,
    productId: string,
    fields: Omit<VariantFields, "sku"> & { sku?: string },
  ): Promise<ProductVariant> => {
    const id = newId();
    const sku = fields.sku ?? id.slice(-8).toUpperCase();
    await withSkuCheck(sku, () =>
      db
        .insertInto("product_variants")
        .values({
          id,
          tenant_id: tenantId,
          product_id: productId,
          ...fields,
          sku,
        })
        .execute(),
    );
    return (await VariantService.getById(tenantId, id))!;
  },

  /** Throws `DuplicateSkuError` when the new SKU is taken. */
  update: async (
    tenantId: string,
    id: string,
    fields: Partial<VariantFields>,
  ): Promise<ProductVariant | null> => {
    if (Object.keys(fields).length > 0) {
      await withSkuCheck(fields.sku ?? "", () =>
        db
          .updateTable("product_variants")
          .set(fields)
          .where("id", "=", id)
          .where("tenant_id", "=", tenantId)
          .execute(),
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
