import { env } from "cloudflare:workers";
import { catalogImageKey, isCatalogImageKey } from "../../lib/storage-paths.ts";

const MAX_SIZE = 1024;
const JPEG_QUALITY = 85;

/**
 * A key never names new bytes, so a cached copy can never go stale. Meta and
 * browsers may keep it for a year.
 */
export const CATALOG_IMAGE_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

/**
 * 16 hex characters of randomness. Catalog image URLs are public because Meta
 * fetches them with no credentials, so the id carries the unguessability.
 */
function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * The Images binding reports input it cannot decode with a 94xx code, 9412
 * for bytes that are not an image.
 */
export function isUnreadableImage(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" && code >= 9400 && code < 9500;
}

/** Fits the image inside 1024 × 1024 without enlarging it, as JPEG. */
async function optimize(bytes: Uint8Array): Promise<Uint8Array> {
  const result = await env.IMAGES.input(new Blob([bytes]).stream())
    .transform({ width: MAX_SIZE, height: MAX_SIZE, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: JPEG_QUALITY });
  return new Uint8Array(await result.response().arrayBuffer());
}

export const imageStorage = {
  /** Writes the image under the tenant's prefix. Returns the new image id. */
  async store(
    tenantId: string,
    bytes: Uint8Array,
  ): Promise<{ imageId: string; byteSize: number }> {
    const optimized = await optimize(bytes);
    const imageId = generateId();
    await imageStorage.put(tenantId, imageId, optimized);
    return { imageId, byteSize: optimized.byteLength };
  },

  /** Writes bytes that are already a JPEG of the right size, as the seed does. */
  async put(
    tenantId: string,
    imageId: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await env.FILES.put(catalogImageKey(tenantId, imageId), bytes, {
      httpMetadata: {
        contentType: "image/jpeg",
        cacheControl: CATALOG_IMAGE_CACHE_CONTROL,
      },
    });
  },

  async exists(tenantId: string, imageId: string): Promise<boolean> {
    return (await env.FILES.head(catalogImageKey(tenantId, imageId))) !== null;
  },

  /** Key recorded on the `assets` row for this image. */
  storageKey(tenantId: string, imageId: string): string {
    return catalogImageKey(tenantId, imageId);
  },

  async delete(tenantId: string, imageId: string): Promise<void> {
    await env.FILES.delete(catalogImageKey(tenantId, imageId));
  },

  /** Deletes by the key an asset row recorded. Refuses any non-image key. */
  async deleteKey(storageKey: string): Promise<void> {
    if (!isCatalogImageKey(storageKey)) {
      throw new Error("Not a catalog image key");
    }
    await env.FILES.delete(storageKey);
  },
};
