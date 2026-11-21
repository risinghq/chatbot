/**
 * `bun run seed` gives the demo business its catalog: each product with one
 * priced variant and opening stock, through the same services the dashboard
 * uses.
 */

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { demoChannelAccount } from "../src/db/seeds/demo.ts";
import { getAll, getOne } from "../src/db/index.ts";
import { seedProducts } from "../src/db/seeds/products.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import { TenantService } from "../src/domains/tenants/index.ts";
import { DEMO_PRODUCTS } from "../src/db/seed-data/products.ts";

describe("seeding a catalog", () => {
  async function tenant(name: string): Promise<string> {
    return (await TenantService.create({ name })).id;
  }

  it("gives each product a priced variant with stock", async () => {
    const tenantId = await tenant("fresh");

    await seedProducts(tenantId);

    const rows = (await getAll(
      `SELECT v.sku, v.price_cents, l.on_hand
         FROM product_variants v
         JOIN stock_levels l ON l.variant_id = v.id
        WHERE v.tenant_id = ?`,
      [tenantId],
    )) as Array<{ sku: string; price_cents: number; on_hand: number }>;

    expect(rows).toHaveLength(DEMO_PRODUCTS.length);
    for (const row of rows) {
      const demo = DEMO_PRODUCTS.find((p) => p.sku === row.sku);
      expect(row.price_cents).toBe(demo?.price_cents);
      expect(row.on_hand).toBeGreaterThan(0);
    }
  });

  // The demo catalog is bootstrap data, not something poured on top of what a
  // business already sells.
  it("leaves a business that has products alone", async () => {
    const tenantId = await tenant("own-catalog");
    await ProductService.create({
      tenantId,
      name: "Propio",
      category: "Otros",
    });

    await seedProducts(tenantId);

    expect(
      await getOne(
        "SELECT COUNT(*) as count FROM products WHERE tenant_id = ?",
        [tenantId],
      ),
    ).toEqual({ count: 1 });
  });
});

describe("seeding the demo number", () => {
  it("creates one pending number per business, however often it runs", async () => {
    const { id: tenantId } = await TenantService.create({ name: "Demo" });

    const first = await demoChannelAccount(tenantId);
    const second = await demoChannelAccount(tenantId);

    expect(first?.status).toBe("pending");
    expect(second?.id).toBe(first?.id);
  });

  // The verify token is stored encrypted, so without SECRETS_KEY the seed
  // creates no account rather than failing.
  it("creates no number without SECRETS_KEY", async () => {
    const { id: tenantId } = await TenantService.create({ name: "no-key" });
    const previous = env.SECRETS_KEY;
    try {
      (env as unknown as Record<string, string>).SECRETS_KEY = "";

      const account = await demoChannelAccount(tenantId);

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
