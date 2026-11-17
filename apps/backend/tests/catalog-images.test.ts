/**
 * A tenant's catalog is seeded from the same base data as every other seeded
 * tenant's, so two tenants' seeded bundles name the same `image_id`. Each
 * tenant holds its own copy of the object, under its own key prefix. Deleting
 * one tenant's bundle never touches another tenant's object, and an object goes
 * only with the last of its tenant's bundles that names it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createTenantFixture, type TenantFixture } from "./helpers/tenancy.ts";

import { getOne, run } from "../src/db/index.ts";

import { imageStorage } from "../src/adapters/storage/images.ts";
import { AssetService } from "../src/domains/assets/index.ts";
import { BundleService } from "../src/domains/catalog/bundles.ts";

const SHARED_IMAGE = "0123456789abcdef";

async function storeImage(
  fixture: TenantFixture,
  imageId: string,
): Promise<string> {
  await imageStorage.put(
    fixture.tenantId,
    imageId,
    new TextEncoder().encode("jpeg-bytes"),
  );
  return imageId;
}

const stored = (fixture: TenantFixture, imageId: string) =>
  imageStorage.exists(fixture.tenantId, imageId);

/** One tenant's copy of a base-catalog bundle, image id and all. */
async function seedBundle(
  fixture: TenantFixture,
  imageId: string,
): Promise<string> {
  const periodId = `per-${crypto.randomUUID()}`;

  await run(
    `INSERT OR IGNORE INTO catalog_periods (id, tenant_id, name, year_month, status)
     VALUES (?, ?, 'Enero', '2026-01', 'active')`,
    [periodId, fixture.tenantId],
  );
  const period = await getOne<{ id: string }>(
    "SELECT id FROM catalog_periods WHERE tenant_id = ? AND year_month = '2026-01'",
    [fixture.tenantId],
  );

  const bundleId = `bundle-${crypto.randomUUID()}`;

  await BundleService.create({
    id: bundleId,
    tenantId: fixture.tenantId,
    period_id: period!.id,
    segment: "gaso",
    name: "Celular a elección + Cocineta 2Q",
    price: 1799,
    primary_category: "celulares",
    categories_json: JSON.stringify(["celulares"]),
    image_id: imageId,
    composition_json: JSON.stringify({ fixed: [], choices: [] }),
    installments_json: JSON.stringify({ "3m": 643.3 }),
    created_by: null,
  });

  return bundleId;
}

describe("a catalog image two tenants were seeded with", () => {
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaBundle: string;
  let betaBundle: string;

  beforeEach(async () => {
    alpha = await createTenantFixture("alpha-images");
    beta = await createTenantFixture("beta-images");

    alphaBundle = await seedBundle(
      alpha,
      await storeImage(alpha, SHARED_IMAGE),
    );
    betaBundle = await seedBundle(beta, await storeImage(beta, SHARED_IMAGE));
  });

  it("is two objects, one under each tenant's prefix", () => {
    expect(imageStorage.storageKey(alpha.tenantId, SHARED_IMAGE)).not.toBe(
      imageStorage.storageKey(beta.tenantId, SHARED_IMAGE),
    );
  });

  it("survives in the other tenant when one replaces its bundle image", async () => {
    const replacement = await storeImage(alpha, "aaaa1111bbbb2222");

    await BundleService.updateImage(alpha.tenantId, alphaBundle, replacement);

    expect(await stored(alpha, SHARED_IMAGE)).toBe(false);
    expect(await stored(beta, SHARED_IMAGE)).toBe(true);
    expect(
      (await BundleService.getById(beta.tenantId, betaBundle))?.image_id,
    ).toBe(SHARED_IMAGE);
    expect(
      (await BundleService.getById(alpha.tenantId, alphaBundle))?.image_id,
    ).toBe(replacement);
  });

  it("survives in the other tenant when one deletes its bundle", async () => {
    await BundleService.delete(alpha.tenantId, alphaBundle);

    expect(await stored(alpha, SHARED_IMAGE)).toBe(false);
    expect(await stored(beta, SHARED_IMAGE)).toBe(true);
    expect(
      await BundleService.getById(beta.tenantId, betaBundle),
    ).not.toBeNull();
  });

  it("takes only the deleting tenant's asset row with it", async () => {
    for (const tenant of [alpha, beta]) {
      await AssetService.create({
        tenantId: tenant.tenantId,
        kind: "catalog_image",
        visibility: "public",
        storageKey: imageStorage.storageKey(tenant.tenantId, SHARED_IMAGE),
      });
    }

    await BundleService.delete(alpha.tenantId, alphaBundle);

    expect(
      await AssetService.getByStorageKey(
        alpha.tenantId,
        imageStorage.storageKey(alpha.tenantId, SHARED_IMAGE),
      ),
    ).toBeFalsy();
    expect(
      await AssetService.getByStorageKey(
        beta.tenantId,
        imageStorage.storageKey(beta.tenantId, SHARED_IMAGE),
      ),
    ).toBeTruthy();
  });
});

describe("a catalog image two bundles of one tenant name", () => {
  let alpha: TenantFixture;
  let first: string;
  let second: string;

  beforeEach(async () => {
    alpha = await createTenantFixture("solo-images");
    await storeImage(alpha, SHARED_IMAGE);
    first = await seedBundle(alpha, SHARED_IMAGE);
    second = await seedBundle(alpha, SHARED_IMAGE);
  });

  it("stays while another bundle still names it", async () => {
    await BundleService.delete(alpha.tenantId, first);

    expect(await stored(alpha, SHARED_IMAGE)).toBe(true);
  });

  it("is deleted with the last bundle that names it", async () => {
    await BundleService.delete(alpha.tenantId, first);
    await BundleService.delete(alpha.tenantId, second);

    expect(await stored(alpha, SHARED_IMAGE)).toBe(false);
  });

  it("is deleted when the last bundle naming it is given a new one", async () => {
    const replacement = await storeImage(alpha, "cccc3333dddd4444");

    await BundleService.delete(alpha.tenantId, first);
    await BundleService.updateImage(alpha.tenantId, second, replacement);

    expect(await stored(alpha, SHARED_IMAGE)).toBe(false);
    expect(await stored(alpha, replacement)).toBe(true);
  });
});
