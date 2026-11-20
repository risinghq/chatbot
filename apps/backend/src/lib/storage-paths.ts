/**
 * Keys of every object in the FILES bucket. Nothing outside this module builds
 * one. Every key starts with the owning tenant's id.
 *
 * `<tenant>/images/<id>.jpg` is a catalog image. It is the only kind served
 * without a session, at `/media/<key>`, because Meta fetches the link of an
 * outgoing image with no credentials. Every other prefix is private and is
 * reachable only through /api/assets/:id, which checks tenant scope first.
 */

const CATALOG_IMAGE_KEY =
  /^([^/]+)\/images\/([0-9a-f]{16}|[A-Za-z0-9_-]+)\.jpg$/;

/** Strip anything that could climb out of the tenant's prefix. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._+-]/g, "_");
  return cleaned === "." || cleaned === ".." || cleaned === "" ? "_" : cleaned;
}

export function catalogImageKey(tenantId: string, imageId: string): string {
  return `${safeSegment(tenantId)}/images/${safeSegment(imageId)}.jpg`;
}

/** Whether a key may be served publicly, which only a catalog image may. */
export function isCatalogImageKey(key: string): boolean {
  return CATALOG_IMAGE_KEY.test(key);
}

/** The path, under the public origin, that serves a catalog image. */
export function catalogImagePath(tenantId: string, imageId: string): string {
  return mediaPath(catalogImageKey(tenantId, imageId));
}

/** The public path of a catalog image key already recorded on an asset row. */
export function mediaPath(catalogKey: string): string {
  return `/media/${catalogKey}`;
}

/**
 * A private key never has `images` as its first segment after the tenant, so
 * `/media` can never serve it.
 */
export function privateStorageKey(
  tenantId: string,
  kind: "contracts" | "recordings",
  ...segments: string[]
): string {
  return [safeSegment(tenantId), kind, ...segments.map(safeSegment)].join("/");
}
