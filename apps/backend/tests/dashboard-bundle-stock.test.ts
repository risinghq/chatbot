/**
 * The stock badge on a bundle card changes the bundle's stock status. The call
 * it makes has to land on a route that updates a bundle, as the browser makes
 * it: a relative URL under `/api`, with the session cookie.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

import { run } from "../src/db/index.ts";
import {
  createMember,
  createTenantFixture,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import { BundleService } from "../src/domains/catalog/bundles.ts";
import catalogRoutes from "../src/routes/catalog.ts";
import { importFrontend } from "./helpers/frontend.ts";

const { updateBundleStock } = await importFrontend<{
  updateBundleStock: (
    bundleId: string,
    stockStatus: "in_stock" | "low_stock" | "out_of_stock",
  ) => Promise<unknown>;
}>("lib/utils/catalog.ts");

const realFetch = globalThis.fetch;

describe("changing a bundle's stock from the dashboard", () => {
  let tenant: TenantFixture;
  let bundleId: string;

  beforeEach(async () => {
    const app = new Hono();
    app.use("/api/*", requireAuth);
    app.route("/api/catalog", catalogRoutes);
    app.onError(errorHandler);

    tenant = await createTenantFixture("bundle-stock");
    const periodId = `per-${crypto.randomUUID()}`;
    await run(
      `INSERT INTO catalog_periods (id, tenant_id, name, year_month, status)
       VALUES (?, ?, 'Enero', '2026-01', 'active')`,
      [periodId, tenant.tenantId],
    );
    bundleId = `bundle-${crypto.randomUUID()}`;
    await BundleService.create({
      id: bundleId,
      tenantId: tenant.tenantId,
      period_id: periodId,
      segment: "gaso",
      name: "Cocina",
      price: 999,
      primary_category: "cocinas",
      categories_json: "[]",
      image_id: "img-1",
      composition_json: "{}",
      installments_json: "[]",
      created_by: null,
    });

    const { userId } = await createMember(tenant, "supervisor");
    const token = generateSessionToken();
    await createSession(token, userId, tenant.tenantId);

    // The browser resolves the relative URL against the dashboard, which
    // forwards it to the backend, and adds the session cookie itself.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      app.request(String(input), {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          Cookie: `session=${token}`,
        },
      })) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
  });

  it("stores the new stock status", async () => {
    await updateBundleStock(bundleId, "out_of_stock");

    expect(
      (await BundleService.getById(tenant.tenantId, bundleId))?.stock_status,
    ).toBe("out_of_stock");
  });

  it("takes the bundle out of what the bot offers", async () => {
    await updateBundleStock(bundleId, "out_of_stock");

    expect(
      (await BundleService.getAvailable(tenant.tenantId)).map((b) => b.id),
    ).toEqual([]);
  });
});
