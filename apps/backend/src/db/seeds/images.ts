import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageStorage } from "../../adapters/storage/images.ts";
import { createLogger } from "../../lib/logger.ts";
import { BUNDLES_SEED } from "../seed-data/bundles.ts";
import { FNB_BUNDLES_SEED } from "../seed-data/fnb-bundles.ts";

const logger = createLogger("seed-images");

/** The seeded photos ship with the repository, already 1024 px JPEGs. */
const SEED_IMAGES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../seed-data/images",
);

/** Every image a seeded bundle names, once each. */
export const SEEDED_IMAGE_IDS: readonly string[] = [
  ...new Set(
    [...BUNDLES_SEED, ...FNB_BUNDLES_SEED].map((bundle) => bundle.image_id),
  ),
];

/**
 * Uploads the seeded catalog photos under the tenant's prefix in R2. An object
 * already there is left alone, so nothing an operator replaced is
 * overwritten. Returns how many it uploaded.
 */
export async function seedCatalogImages(tenantId: string): Promise<number> {
  let uploaded = 0;

  for (const imageId of SEEDED_IMAGE_IDS) {
    if (await imageStorage.exists(tenantId, imageId)) continue;
    const bytes = await readFile(path.join(SEED_IMAGES, `${imageId}.jpg`));

    await imageStorage.put(tenantId, imageId, new Uint8Array(bytes));
    uploaded++;
  }

  if (uploaded > 0) {
    logger.info({ tenantId, uploaded }, "Uploaded seeded catalog images");
  }
  return uploaded;
}
