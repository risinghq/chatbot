import type { ProductImage } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { imageStorage } from "../../adapters/storage/images.ts";
import { batch, getAll, getOne, stmt } from "../../db/index.ts";
import { mediaPath } from "../../lib/storage-paths.ts";

/** How many photos one product may hold. */
export const MAX_PRODUCT_IMAGES = 10;

type ImageRow = Omit<ProductImage, "url"> & { storage_key: string };

const SELECT_IMAGES = `SELECT i.id, i.product_id, i.asset_id, i.position, i.created_at,
       a.storage_key
  FROM product_images i
  JOIN assets a ON a.id = i.asset_id AND a.tenant_id = i.tenant_id
 WHERE i.tenant_id = ?`;

function toImage({ storage_key, ...row }: ImageRow): ProductImage {
  return { ...row, url: mediaPath(storage_key) };
}

/**
 * Positions may have gaps after a delete. Order is position, then id, and a
 * reorder rewrites them as 0..n-1.
 */
export const ProductImageService = {
  list: async (tenantId: string, productId: string): Promise<ProductImage[]> =>
    (
      await getAll<ImageRow>(
        `${SELECT_IMAGES}
           AND i.product_id = ?
         ORDER BY i.position, i.id`,
        [tenantId, productId],
      )
    ).map(toImage),

  get: async (tenantId: string, id: string): Promise<ProductImage | null> => {
    const row = await getOne<ImageRow>(`${SELECT_IMAGES} AND i.id = ?`, [
      tenantId,
      id,
    ]);
    return row ? toImage(row) : null;
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
      stmt(
        `INSERT INTO assets
           (id, tenant_id, kind, visibility, storage_key, content_type, byte_size, created_by)
         VALUES (?, ?, 'catalog_image', 'public', ?, 'image/jpeg', ?, ?)`,
        [
          assetId,
          tenantId,
          imageStorage.storageKey(tenantId, image.imageId),
          image.byteSize,
          image.createdBy,
        ],
      ),
      stmt(
        `INSERT INTO product_images (id, tenant_id, product_id, asset_id, position)
         SELECT ?, ?, ?, ?, COALESCE(MAX(position) + 1, 0)
         FROM product_images WHERE tenant_id = ? AND product_id = ?`,
        [id, tenantId, productId, assetId, tenantId, productId],
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
    const row = await getOne<{ asset_id: string; storage_key: string }>(
      `SELECT i.asset_id, a.storage_key
       FROM product_images i
       JOIN assets a ON a.id = i.asset_id AND a.tenant_id = i.tenant_id
       WHERE i.tenant_id = ? AND i.id = ?`,
      [tenantId, id],
    );
    if (!row) return false;
    await batch([
      stmt(`DELETE FROM product_images WHERE id = ? AND tenant_id = ?`, [
        id,
        tenantId,
      ]),
      stmt(`DELETE FROM assets WHERE id = ? AND tenant_id = ?`, [
        row.asset_id,
        tenantId,
      ]),
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
    if (ids.length > 0) {
      await batch(
        ids.map((id, position) =>
          stmt(
            `UPDATE product_images SET position = ?
             WHERE id = ? AND tenant_id = ? AND product_id = ?`,
            [position, id, tenantId, productId],
          ),
        ),
      );
    }
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
