import type { Product, ProductStatus } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { db, tenantScope } from "../../db/index.ts";
import { mediaPath } from "../../lib/storage-paths.ts";

type ProductFields = Pick<
  Product,
  | "name"
  | "description"
  | "status"
  | "category"
  | "brand"
  | "model"
  | "specs_json"
>;

const EDITABLE: readonly (keyof ProductFields)[] = [
  "name",
  "description",
  "status",
  "category",
  "brand",
  "model",
  "specs_json",
];

export const ProductService = {
  getAll: async (tenantId: string): Promise<Product[]> => {
    const rows = await db
      .selectFrom("products as p")
      .selectAll("p")
      .select((eb) => [
        eb
          .selectFrom("product_variants as v")
          .select(eb.fn.countAll<number>().as("n"))
          .whereRef("v.product_id", "=", "p.id")
          .whereRef("v.tenant_id", "=", "p.tenant_id")
          .as("variant_count"),
        eb
          .selectFrom("product_images as i")
          .innerJoin("assets as a", (join) =>
            join
              .onRef("a.id", "=", "i.asset_id")
              .onRef("a.tenant_id", "=", "i.tenant_id"),
          )
          .select("a.storage_key")
          .whereRef("i.product_id", "=", "p.id")
          .whereRef("i.tenant_id", "=", "p.tenant_id")
          .orderBy("i.position")
          .orderBy("i.id")
          .limit(1)
          .as("cover_key"),
      ])
      .where(tenantScope(tenantId, "p.tenant_id"))
      .orderBy("p.category")
      .orderBy("p.name")
      .execute();
    return rows.map(({ cover_key, variant_count, ...product }) => ({
      ...product,
      variant_count: variant_count ?? 0,
      cover_url: cover_key ? mediaPath(cover_key) : null,
    }));
  },

  getById: async (tenantId: string, id: string): Promise<Product | null> =>
    (await db
      .selectFrom("products")
      .selectAll()
      .where("id", "=", id)
      .where(tenantScope(tenantId))
      .executeTakeFirst()) ?? null,

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
    await db
      .insertInto("products")
      .values({
        id,
        tenant_id: data.tenantId,
        name: data.name,
        description: data.description || null,
        status: data.status ?? "active",
        category: data.category,
        brand: data.brand || null,
        model: data.model || null,
        specs_json: data.specs_json || null,
      })
      .execute();
    return (await ProductService.getById(data.tenantId, id))!;
  },

  update: async (
    tenantId: string,
    id: string,
    data: Partial<Product>,
  ): Promise<Product | null> => {
    const changes = Object.fromEntries(
      EDITABLE.filter((key) => data[key] !== undefined).map((key) => [
        key,
        data[key],
      ]),
    ) as Partial<ProductFields>;
    if (Object.keys(changes).length > 0) {
      await db
        .updateTable("products")
        .set(changes)
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId)
        .execute();
    }
    return await ProductService.getById(tenantId, id);
  },

  getCategories: async (tenantId: string): Promise<string[]> => {
    const rows = await db
      .selectFrom("products")
      .select("category")
      .distinct()
      .where(tenantScope(tenantId))
      .orderBy("category")
      .execute();
    return rows.map((r) => r.category);
  },
};
