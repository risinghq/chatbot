import type { ProductImage } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { imageStorage } from "../../adapters/storage/images.ts";
import { batch, db } from "../../db/index.ts";
import { mediaPath } from "../../lib/storage-paths.ts";

/** How many photos one product may hold. */
export const MAX_PRODUCT_IMAGES = 10;

/** A tenant's photos with the storage key of each one's asset. */
function images(tenantId: string) {
  return db
    .selectFrom("product_images as i")
    .innerJoin("assets as a", (join) =>
      join
        .onRef("a.id", "=", "i.asset_id")
        .onRef("a.tenant_id", "=", "i.tenant_id"),
    )
    .select([
      "i.id",
      "i.product_id",
      "i.asset_id",
      "i.position",
      "i.created_at",
      "a.storage_key",
    ])
    .where("i.tenant_id", "=", tenantId);
}

type ImageRow = Omit<ProductImage, "url" | "variant_ids"> & {
  storage_key: string;
};

/** Each photo's rows with the variants it shows, in the order given. */
async function withVariants(
  tenantId: string,
  rows: ImageRow[],
): Promise<Array<ImageRow & { variant_ids: string[] }>> {
  if (rows.length === 0) return [];
  const links = await db
    .selectFrom("product_image_variants")
    .select(["image_id", "variant_id"])
    .where("tenant_id", "=", tenantId)
    .where(
      "image_id",
      "in",
      rows.map((row) => row.id),
    )
    .orderBy("variant_id")
    .execute();
  const byImage = Map.groupBy(links, (link) => link.image_id);
  return rows.map((row) => ({
    ...row,
    variant_ids: (byImage.get(row.id) ?? []).map((link) => link.variant_id),
  }));
}

function toImage({
  storage_key,
  ...row
}: ImageRow & { variant_ids: string[] }): ProductImage {
  return { ...row, url: mediaPath(storage_key) };
}

/**
 * Positions may have gaps after a delete. Order is position, then id, and a
 * reorder rewrites them as 0..n-1.
 */
export const ProductImageService = {
  list: async (tenantId: string, productId: string): Promise<ProductImage[]> =>
    (
      await withVariants(
        tenantId,
        await images(tenantId)
          .where("i.product_id", "=", productId)
          .orderBy("i.position")
          .orderBy("i.id")
          .execute(),
      )
    ).map(toImage),

  /**
   * The storage keys of a product's first `limit` photos, in order. With a
   * variant, that variant's own photos come first, then the whole-product
   * photos; a photo tagged only for other variants is left out.
   */
  storageKeys: async (
    tenantId: string,
    productId: string,
    limit: number,
    variantId?: string,
  ): Promise<string[]> => {
    const rows = await withVariants(
      tenantId,
      await images(tenantId)
        .where("i.product_id", "=", productId)
        .orderBy("i.position")
        .orderBy("i.id")
        .execute(),
    );
    if (!variantId) return rows.slice(0, limit).map((row) => row.storage_key);
    const own = rows.filter((row) => row.variant_ids.includes(variantId));
    const whole = rows.filter((row) => row.variant_ids.length === 0);
    return [...own, ...whole].slice(0, limit).map((row) => row.storage_key);
  },

  get: async (tenantId: string, id: string): Promise<ProductImage | null> => {
    const row = await images(tenantId)
      .where("i.id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    const [image] = await withVariants(tenantId, [row]);
    return toImage(image!);
  },

  /**
   * Sets the variants a photo shows; an empty list makes it a whole-product
   * photo. Null when the photo is not the tenant's or a variant is not one of
   * the photo's product.
   */
  setVariants: async (
    tenantId: string,
    id: string,
    variantIds: string[],
  ): Promise<ProductImage | null> => {
    const row = await images(tenantId)
      .where("i.id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    const wanted = [...new Set(variantIds)];
    if (wanted.length > 0) {
      const found = await db
        .selectFrom("product_variants")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("product_id", "=", row.product_id)
        .where("id", "in", wanted)
        .execute();
      if (found.length !== wanted.length) return null;
    }
    await batch([
      db
        .deleteFrom("product_image_variants")
        .where("tenant_id", "=", tenantId)
        .where("image_id", "=", id),
      ...wanted.map((variantId) =>
        db.insertInto("product_image_variants").values({
          image_id: id,
          variant_id: variantId,
          tenant_id: tenantId,
        }),
      ),
    ]);
    return await ProductImageService.get(tenantId, id);
  },

  /**
   * Records an image already written under `imageId` as the product's last
   * photo. The asset row and the placement land together. The caller has
   * checked that the product belongs to the tenant and has room.
   */
  add: async (image: {
    tenantId: string;
    productId: string;
    imageId: string;
    byteSize: number;
    createdBy: string | null;
  }): Promise<ProductImage> => {
    const { tenantId, productId } = image;
    const id = newId();
    const assetId = newId();
    await batch([
      db.insertInto("assets").values({
        id: assetId,
        tenant_id: tenantId,
        kind: "catalog_image",
        visibility: "public",
        storage_key: imageStorage.storageKey(tenantId, image.imageId),
        content_type: "image/jpeg",
        byte_size: image.byteSize,
        created_by: image.createdBy,
      }),
      db
        .insertInto("product_images")
        .columns(["id", "tenant_id", "product_id", "asset_id", "position"])
        .expression((eb) =>
          eb
            .selectFrom("product_images")
            .select([
              eb.val(id).as("id"),
              eb.val(tenantId).as("tenant_id"),
              eb.val(productId).as("product_id"),
              eb.val(assetId).as("asset_id"),
              eb.fn
                .coalesce(eb(eb.fn.max("position"), "+", 1), eb.lit(0))
                .as("position"),
            ])
            .where("tenant_id", "=", tenantId)
            .where("product_id", "=", productId),
        ),
    ]);
    return (await ProductImageService.get(tenantId, id))!;
  },

  /**
   * Deletes the placement and its asset row, then the object. Rows go first:
   * a failed object delete leaves an unreferenced object, never a photo that
   * points at nothing. False when the image is not the tenant's.
   */
  remove: async (tenantId: string, id: string): Promise<boolean> => {
    const row = await images(tenantId)
      .where("i.id", "=", id)
      .executeTakeFirst();
    if (!row) return false;
    await batch([
      db
        .deleteFrom("product_images")
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId),
      db
        .deleteFrom("assets")
        .where("id", "=", row.asset_id)
        .where("tenant_id", "=", tenantId),
    ]);
    await imageStorage.deleteKey(row.storage_key);
    return true;
  },

  /**
   * Puts the product's photos in the order given; the first becomes the cover.
   * `ids` must name each current photo exactly once. Null when it does not.
   */
  reorder: async (
    tenantId: string,
    productId: string,
    ids: string[],
  ): Promise<ProductImage[] | null> => {
    const current = await ProductImageService.list(tenantId, productId);
    if (
      !sameSet(
        current.map((image) => image.id),
        ids,
      )
    )
      return null;
    await batch(
      ids.map((id, position) =>
        db
          .updateTable("product_images")
          .set({ position })
          .where("id", "=", id)
          .where("tenant_id", "=", tenantId)
          .where("product_id", "=", productId),
      ),
    );
    return await ProductImageService.list(tenantId, productId);
  },
};

function sameSet(current: string[], given: string[]): boolean {
  const unique = new Set(given);
  return (
    unique.size === given.length &&
    given.length === current.length &&
    current.every((id) => unique.has(id))
  );
}
