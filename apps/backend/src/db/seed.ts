import process from "node:process";
import { withPlatform } from "../cli/platform.ts";

/**
 * Seeds the default tenant, its channel account, a catalog with its photos
 * and, outside production, sample conversations. Every step skips what is
 * already there, so running it again changes nothing. `--remote` seeds the
 * deployed database and bucket.
 */
const remote = process.argv.includes("--remote");

await withPlatform({ remote }, async () => {
  const { seedTenants } = await import("./seeds/tenants.ts");
  const { seedPeriods } = await import("./seeds/periods.ts");
  const { seedProducts } = await import("./seeds/products.ts");
  const { seedBundles } = await import("./seeds/bundles.ts");
  const { seedCatalogImages } = await import("./seeds/images.ts");
  const { seedTestData } = await import("./seeds/test-data.ts");

  const { tenant, channelAccount } = await seedTenants();
  await seedPeriods(tenant.id);
  await seedProducts(tenant.id);
  await seedBundles(tenant.id);
  await seedCatalogImages(tenant.id);
  if (!remote && channelAccount) {
    await seedTestData(tenant.id, channelAccount.id);
  }

  console.log(`Seeded tenant ${tenant.slug} (${tenant.id}).`);
});
