import { tenantPredicate } from "../../db/query.ts";
import { periodId } from "./ids.ts";
import type { CatalogPeriod, PeriodStatus } from "@vendeya/types";
import { getAll, getOne, run } from "../../db/index.ts";

type CreatePeriodData = {
  tenantId: string;
  name: string;
  year_month: string;
  created_by: string | null;
};

/**
 * `tenantId` null reads across open tenants. Only the read routes pass it, for
 * an unpinned platform operator. Writes take a concrete id from
 * `activeTenantId`.
 */
export const PeriodService = {
  getAll: async (tenantId: string | null): Promise<CatalogPeriod[]> =>
    await getAll<CatalogPeriod>(
      `SELECT * FROM catalog_periods
       WHERE ${tenantPredicate(tenantId)}
       ORDER BY year_month DESC`,
      tenantId ? [tenantId] : [],
    ),

  getById: async (
    tenantId: string | null,
    id: string,
  ): Promise<CatalogPeriod | null> =>
    (await getOne<CatalogPeriod>(
      `SELECT * FROM catalog_periods
       WHERE id = ? AND ${tenantPredicate(tenantId)}`,
      tenantId ? [id, tenantId] : [id],
    )) ?? null,

  getActive: async (tenantId: string): Promise<CatalogPeriod | null> =>
    (await getOne<CatalogPeriod>(
      "SELECT * FROM catalog_periods WHERE tenant_id = ? AND status = 'active' LIMIT 1",
      [tenantId],
    )) ?? null,

  getByYearMonth: async (
    tenantId: string,
    yearMonth: string,
  ): Promise<CatalogPeriod | null> =>
    (await getOne<CatalogPeriod>(
      "SELECT * FROM catalog_periods WHERE tenant_id = ? AND year_month = ?",
      [tenantId, yearMonth],
    )) ?? null,

  create: async (data: CreatePeriodData): Promise<CatalogPeriod> => {
    const id = periodId(data.tenantId, data.year_month);

    await run(
      `INSERT INTO catalog_periods (id, tenant_id, name, year_month, status, created_by)
       VALUES (?, ?, ?, ?, 'draft', ?)`,
      [id, data.tenantId, data.name, data.year_month, data.created_by],
    );

    return (await PeriodService.getById(data.tenantId, id))!;
  },

  updateStatus: async (
    tenantId: string,
    id: string,
    status: PeriodStatus,
  ): Promise<CatalogPeriod> => {
    const now = Date.now();

    if (status === "active") {
      // Deactivate any currently active period *for this tenant only*
      await run(
        "UPDATE catalog_periods SET status = 'archived' WHERE tenant_id = ? AND status = 'active'",
        [tenantId],
      );

      // Set this one active with published timestamp
      await run(
        "UPDATE catalog_periods SET status = 'active', published_at = ? WHERE id = ? AND tenant_id = ?",
        [now, id, tenantId],
      );
    } else {
      await run(
        "UPDATE catalog_periods SET status = ? WHERE id = ? AND tenant_id = ?",
        [status, id, tenantId],
      );
    }

    return (await PeriodService.getById(tenantId, id))!;
  },

  delete: async (
    tenantId: string,
    id: string,
  ): Promise<{ success: boolean; message?: string }> => {
    // Only allow deleting draft periods with no products
    const period = await PeriodService.getById(tenantId, id);
    if (!period) {
      return { success: false, message: "Período no encontrado" };
    }

    if (period.status !== "draft") {
      return {
        success: false,
        message: "Solo se pueden eliminar períodos en borrador",
      };
    }

    // Check for bundles
    const bundleCount = (await getOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM catalog_bundles WHERE tenant_id = ? AND period_id = ?",
      [tenantId, id],
    ))!;

    if (bundleCount.count > 0) {
      return {
        success: false,
        message: "No se puede eliminar un período con productos",
      };
    }

    await run("DELETE FROM catalog_periods WHERE id = ? AND tenant_id = ?", [
      id,
      tenantId,
    ]);
    return { success: true };
  },
};
