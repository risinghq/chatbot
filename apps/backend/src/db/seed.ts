import process from "node:process";
import { parseArgs } from "node:util";
import { withPlatform } from "../cli/platform.ts";

/**
 * Loads a demo business into the local database for development: the sample
 * catalog with its photos and, when SECRETS_KEY is set, a pending demo number
 * with sample conversations. `--tenant <id>` loads it into an existing
 * business instead of a new one. Only the local database is seeded: a real
 * business starts at signup and owns everything it sells.
 */
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { tenant: { type: "string" } },
});

await withPlatform({ remote: false }, async () => {
  const { demoBusiness, demoChannelAccount } = await import("./seeds/demo.ts");
  const { seedPeriods } = await import("./seeds/periods.ts");
  const { seedProducts } = await import("./seeds/products.ts");
  const { seedBundles } = await import("./seeds/bundles.ts");
  const { seedCatalogImages } = await import("./seeds/images.ts");
  const { seedTestData } = await import("./seeds/test-data.ts");

  const tenant = await demoBusiness(values.tenant);
  await seedPeriods(tenant.id);
  await seedProducts(tenant.id);
  await seedBundles(tenant.id);
  await seedCatalogImages(tenant.id);

  const channelAccount = await demoChannelAccount(tenant.id);
  if (channelAccount) await seedTestData(tenant.id, channelAccount.id);

  console.log(`Seeded ${tenant.name} (${tenant.id}).`);
});
