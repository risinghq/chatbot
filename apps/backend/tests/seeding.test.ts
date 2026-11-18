/**
 * `bun run seed` gives a tenant its catalog. Foreign keys hold on D1, so a
 * bundle naming a missing period fails here as it would in a real seed.
 */

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { ensureChannelAccountFromEnv } from "../src/db/seeds/tenants.ts";
import { getAll, getOne, run } from "../src/db/index.ts";
import { seedPeriods } from "../src/db/seeds/periods.ts";
import { seedProducts } from "../src/db/seeds/products.ts";
import { seedBundles } from "../src/db/seeds/bundles.ts";
import { TenantService } from "../src/domains/tenants/index.ts";
import { periodId } from "../src/domains/catalog/ids.ts";
import { currentPeriodId } from "../src/db/seeds/periods.ts";
import { BASE_PRODUCTS } from "../src/db/seed-data/products.ts";

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

describe("seeding a catalog", () => {
  async function tenant(slug: string, id?: string): Promise<string> {
    return (await TenantService.create({ slug, name: slug, id })).id;
  }

  async function seedCatalog(tenantId: string): Promise<void> {
    await seedPeriods(tenantId);
    await seedProducts(tenantId);
    await seedBundles(tenantId);
  }

  async function periods(
    tenantId: string,
  ): Promise<Array<{ year_month: string; status: string }>> {
    return (await getAll(
      "SELECT year_month, status FROM catalog_periods WHERE tenant_id = ? ORDER BY year_month",
      [tenantId],
    )) as Array<{ year_month: string; status: string }>;
  }

  /** The period a tenant onboarded in, months ago. */
  async function olderPeriod(tenantId: string): Promise<string> {
    const id = periodId(tenantId, "2020-01");

    await run(
      `INSERT INTO catalog_periods (id, tenant_id, name, year_month, status)
       VALUES (?, ?, 'Enero 2020', '2020-01', 'active')`,
      [id, tenantId],
    );

    return id;
  }

  async function insertBundle(tenantId: string, period: string): Promise<void> {
    await run(
      `INSERT INTO catalog_bundles
         (id, tenant_id, period_id, segment, name, price, primary_category,
          categories_json, image_id, composition_json, installments_json)
       VALUES (?, ?, ?, 'gaso', 'Combo propio', 999, 'celulares', '[]', 'img', '{}', '{}')`,
      [`bundle-${crypto.randomUUID()}`, tenantId, period],
    );
  }

  async function bundleCount(tenantId: string): Promise<number> {
    return (
      (await getOne(
        "SELECT COUNT(*) as count FROM catalog_bundles WHERE tenant_id = ?",
        [tenantId],
      )) as { count: number }
    ).count;
  }

  // The period seed must create the current month's period if it doesn't exist,
  // so bundles can be seeded into it.
  it("seeds a tenant whose only period predates this month", async () => {
    const tenantId = await tenant("migrated");
    await olderPeriod(tenantId);

    await seedCatalog(tenantId);

    expect(await periods(tenantId)).toEqual([
      { year_month: "2020-01", status: "active" },
      // The live catalog is left alone. The new month arrives as a draft.
      { year_month: currentYearMonth(), status: "draft" },
    ]);

    expect(await bundleCount(tenantId)).toBeGreaterThan(0);
    expect(
      await getAll(
        "SELECT DISTINCT period_id FROM catalog_bundles WHERE tenant_id = ?",
        [tenantId],
      ),
    ).toEqual([{ period_id: currentPeriodId(tenantId) }]);
  });

  it("leaves a tenant's own catalog alone when the month rolls over", async () => {
    const tenantId = await tenant("rollover");
    const period = await olderPeriod(tenantId);
    await insertBundle(tenantId, period);

    await seedCatalog(tenantId);

    // The base catalog is bootstrap data for a new tenant, not something poured
    // into every month on top of what the business actually sells.
    expect(await bundleCount(tenantId)).toBe(1);
    expect(await periods(tenantId)).toHaveLength(2);
  });

  it("gives a brand-new tenant an active period to sell from", async () => {
    const tenantId = await tenant("fresh");
    await seedCatalog(tenantId);

    expect(await periods(tenantId)).toEqual([
      { year_month: currentYearMonth(), status: "active" },
    ]);
  });

  // Product ids embed enough of the tenant id to stay unique when tenant ids
  // share a prefix.
  it("keeps two tenants whose ids share a prefix apart", async () => {
    const first = await tenant(
      "prefix-one",
      "aaaaaaaa-1111-4111-8111-111111111111",
    );
    const second = await tenant(
      "prefix-two",
      "aaaaaaaa-2222-4222-8222-222222222222",
    );

    await seedCatalog(first);
    await seedCatalog(second);

    for (const tenantId of [first, second]) {
      const products = (await getOne(
        "SELECT COUNT(*) as count FROM products WHERE tenant_id = ?",
        [tenantId],
      )) as { count: number };

      expect(products.count).toBe(BASE_PRODUCTS.length);
      expect(await bundleCount(tenantId)).toBeGreaterThan(0);
    }
  });
});

describe("seeding the channel account", () => {
  // Credentials are stored encrypted, so without SECRETS_KEY the seed creates
  // no account rather than a pending one that can never gain a token.
  it("creates no channel account without SECRETS_KEY", async () => {
    const { id: tenantId } = await TenantService.create({
      slug: "no-key",
      name: "no-key",
    });
    const previous = env.SECRETS_KEY;
    try {
      (env as unknown as Record<string, string>).SECRETS_KEY = "";

      const account = await ensureChannelAccountFromEnv(tenantId);

      expect(account).toBeNull();
      expect(
        await getOne(
          "SELECT COUNT(*) as count FROM channel_accounts WHERE tenant_id = ?",
          [tenantId],
        ),
      ).toEqual({ count: 0 });
    } finally {
      (env as unknown as Record<string, string>).SECRETS_KEY = previous;
    }
  });
});
