import { Hono } from "hono";
import { ORDER_STATUSES, type OrderStatus } from "@vendeya/types";
import { limaDateString, limaDayBounds, limaRangeEdge } from "../db/query.ts";
import { ReportService } from "../domains/reports/index.ts";
import { reportSummary } from "../domains/reports/summary.ts";
import { requireRole, requireTenantScope } from "../middleware/auth.ts";

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const reports = new Hono();

reports.use(
  "/*",
  requireTenantScope,
  requireRole("admin", "developer", "supervisor"),
);

reports.get("/today-count", async (c) => {
  const count = await ReportService.getTodayContactCount(
    c.get("scope").tenantId,
  );
  return c.json({ count });
});

/** Longest range the summary answers, so its day series stays a page long. */
const SUMMARY_MAX_DAYS = 366;

reports.get("/summary", async (c) => {
  const startDateStr = c.req.query("startDate");
  const endDateStr = c.req.query("endDate");
  const startMs = startDateStr
    ? limaRangeEdge(startDateStr, "start", "startDate")
    : limaDayBounds()[0];
  const endMs = endDateStr
    ? limaRangeEdge(endDateStr, "end", "endDate")
    : limaDayBounds()[1];
  if (endMs < startMs) {
    return c.json({ error: "endDate must not be before startDate" }, 400);
  }
  if (endMs - startMs >= SUMMARY_MAX_DAYS * 24 * 60 * 60 * 1000) {
    return c.json(
      { error: `the range must be at most ${SUMMARY_MAX_DAYS} days` },
      400,
    );
  }

  return c.json(
    await reportSummary({ tenantId: c.get("scope").tenantId, startMs, endMs }),
  );
});

reports.get("/activity", async (c) => {
  const startDateStr = c.req.query("startDate");
  const endDateStr = c.req.query("endDate");

  const startMs = startDateStr
    ? limaRangeEdge(startDateStr, "start", "startDate")
    : limaDayBounds()[0];
  const endMs = endDateStr
    ? limaRangeEdge(endDateStr, "end", "endDate")
    : limaDayBounds()[1];

  const buffer = await ReportService.generateActivityReport({
    tenantId: c.get("scope").tenantId,
    startDate: new Date(startMs),
    endDate: new Date(endMs),
  });

  const filename = `reporte-actividad-${limaDateString(startMs)}-a-${limaDateString(endMs)}.xlsx`;

  c.header("Content-Type", XLSX_TYPE);
  c.header("Content-Disposition", `attachment; filename="${filename}"`);

  return c.body(buffer);
});

reports.get("/orders", async (c) => {
  const startDateStr = c.req.query("startDate");
  const endDateStr = c.req.query("endDate");
  const status = c.req.query("status") || undefined;
  if (status && !ORDER_STATUSES.includes(status as OrderStatus)) {
    return c.json(
      { error: `status must be one of ${ORDER_STATUSES.join(", ")}` },
      400,
    );
  }

  const startMs = startDateStr
    ? limaRangeEdge(startDateStr, "start", "startDate")
    : undefined;
  const endMs = endDateStr
    ? limaRangeEdge(endDateStr, "end", "endDate")
    : undefined;

  const buffer = await ReportService.generateOrderReport({
    tenantId: c.get("scope").tenantId,
    startDate: startMs === undefined ? undefined : new Date(startMs),
    endDate: endMs === undefined ? undefined : new Date(endMs),
    status: status as OrderStatus | undefined,
  });

  const dateRange =
    startMs === undefined
      ? "todas"
      : `${limaDateString(startMs)}-a-${endMs === undefined ? "hoy" : limaDateString(endMs)}`;
  const filename = `reporte-ordenes-${dateRange}.xlsx`;

  c.header("Content-Type", XLSX_TYPE);
  c.header("Content-Disposition", `attachment; filename="${filename}"`);

  return c.body(buffer);
});

export default reports;
