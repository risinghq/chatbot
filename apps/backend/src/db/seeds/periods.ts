import { periodId } from "../../domains/catalog/ids.ts";
import { getOne, run } from "../index.ts";

const MONTH_NAMES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

export function getCurrentPeriod(tenantId: string) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const yearMonth = `${year}-${String(month + 1).padStart(2, "0")}`;
  const name = `${MONTH_NAMES[month]} ${year}`;

  return { id: periodId(tenantId, yearMonth), name, yearMonth };
}

/**
 * Ensures the tenant has a period for the current month, because the catalog
 * seed inserts its bundles into that period.
 */
export async function seedPeriods(tenantId: string) {
  const period = getCurrentPeriod(tenantId);

  // Check for this month's period, not for any period. A tenant created in an
  // earlier month has periods but not this one, and the bundle insert would
  // then fail its foreign key.
  const existing = (await getOne(
    "SELECT count(*) as count FROM catalog_periods WHERE tenant_id = ? AND year_month = ?",
    [tenantId, period.yearMonth],
  )) as { count: number };

  if (existing.count > 0) {
    return;
  }

  const anyPeriod = (await getOne(
    "SELECT count(*) as count FROM catalog_periods WHERE tenant_id = ?",
    [tenantId],
  )) as { count: number };

  // A tenant that already has a period keeps its live catalog. The new month
  // is a draft to publish, not a second active period.
  const status = anyPeriod.count > 0 ? "draft" : "active";

  await run(
    `INSERT INTO catalog_periods (id, tenant_id, name, year_month, status, created_by)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [period.id, tenantId, period.name, period.yearMonth, status],
  );
}

/** The id of the period for the month we are in, seeded or not. */
export function currentPeriodId(tenantId: string): string {
  return getCurrentPeriod(tenantId).id;
}
