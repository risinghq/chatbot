/** Range queries and writes on the millisecond columns: a report's range, the activity report, `last_activity_at`. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as XLSX from "xlsx";

import { getOne, run } from "./helpers/db.ts";
import { limaDayBounds, limaRangeEdge } from "../src/db/query.ts";
import {
  createTenantFixture,
  insertConversation,
  insertUser,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { ReportService } from "../src/domains/reports/index.ts";
import { refreshLastActivity, release } from "../src/conversation/store.ts";
import { takeoverConversation } from "../src/domains/conversations/write.ts";

const CUSTOMER = "51900111222";

async function setLastActivity(
  fixture: TenantFixture,
  at: number,
): Promise<void> {
  await run(
    `UPDATE conversations SET last_activity_at = ?
     WHERE tenant_id = ? AND phone_number = ?`,
    [at, fixture.tenantId, CUSTOMER],
  );
}

async function lastActivity(fixture: TenantFixture): Promise<unknown> {
  return (
    (await getOne(
      "SELECT last_activity_at FROM conversations WHERE tenant_id = ? AND phone_number = ?",
      [fixture.tenantId, CUSTOMER],
    )) as { last_activity_at: unknown }
  ).last_activity_at;
}

async function activityReport(
  tenantId: string,
  [start, end]: [number, number],
): Promise<XLSX.WorkBook> {
  const buffer = await ReportService.generateActivityReport({
    tenantId,
    startDate: new Date(start),
    endDate: new Date(end),
  });
  return XLSX.read(buffer, { type: "buffer" });
}

/** Rows in the activity report for the Lima day `date`, or today's. */
async function dayRows(tenantId: string, date?: string): Promise<number> {
  const workbook = await activityReport(tenantId, limaDayBounds(date));
  const [name] = workbook.SheetNames;
  return XLSX.utils.sheet_to_json(workbook.Sheets[name ?? ""] ?? {}).length;
}

// The dashboard's day is America/Lima, cut on a Worker whose clock is UTC.
describe("date ranges over millisecond columns", () => {
  let tenant: TenantFixture;

  beforeEach(async () => {
    tenant = await createTenantFixture("date-bounds");
    await insertConversation(tenant.ref(CUSTOMER));
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  describe("a range edge", () => {
    it("closes a date-only end on the last millisecond of that Lima day", () => {
      expect(limaRangeEdge("2026-03-10", "end", "endDate")).toBe(
        Date.parse("2026-03-10T23:59:59.999-05:00"),
      );
    });

    it("opens a date-only start at Lima midnight", () => {
      expect(limaRangeEdge("2026-03-10", "start", "startDate")).toBe(
        Date.parse("2026-03-10T00:00:00.000-05:00"),
      );
    });

    it("keeps the exact instant of a timestamp with a zone", () => {
      expect(limaRangeEdge("2026-03-10T12:00:00.000Z", "start", "s")).toBe(
        Date.parse("2026-03-10T12:00:00.000Z"),
      );
      expect(limaRangeEdge("2026-03-10T12:00:00.000Z", "end", "e")).toBe(
        Date.parse("2026-03-10T12:00:00.000Z"),
      );
    });

    it("refuses a bound that is not a date", () => {
      expect(() => limaRangeEdge("garbage", "start", "startDate")).toThrow(
        "startDate must be YYYY-MM-DD or an ISO timestamp with a zone",
      );
      expect(() => limaRangeEdge("2026-02-30", "end", "endDate")).toThrow(
        "endDate must be YYYY-MM-DD or an ISO timestamp with a zone",
      );
    });
  });

  describe("the activity report", () => {
    it("lists a conversation active that day", async () => {
      await setLastActivity(tenant, Date.parse("2026-03-10T12:00:00-05:00"));

      expect(await dayRows(tenant.tenantId, "2026-03-10")).toBe(1);
    });

    it("leaves out a conversation active on another day", async () => {
      await setLastActivity(tenant, Date.parse("2026-03-11T12:00:00-05:00"));

      expect(await dayRows(tenant.tenantId, "2026-03-10")).toBe(0);
    });

    it("opens at Lima midnight", async () => {
      await setLastActivity(
        tenant,
        Date.parse("2026-09-19T00:00:00.000-05:00"),
      );

      expect(await dayRows(tenant.tenantId, "2026-09-19")).toBe(1);
    });

    it("leaves out the last moment of the Lima day before", async () => {
      await setLastActivity(
        tenant,
        Date.parse("2026-09-18T23:59:59.999-05:00"),
      );

      expect(await dayRows(tenant.tenantId, "2026-09-19")).toBe(0);
    });

    it("closes on the last millisecond of the Lima day", async () => {
      await setLastActivity(
        tenant,
        Date.parse("2026-09-19T23:59:59.999-05:00"),
      );

      expect(await dayRows(tenant.tenantId, "2026-09-19")).toBe(1);
    });

    it("leaves out Lima midnight of the next day", async () => {
      await setLastActivity(
        tenant,
        Date.parse("2026-09-20T00:00:00.000-05:00"),
      );

      expect(await dayRows(tenant.tenantId, "2026-09-19")).toBe(0);
    });

    it("names its sheet for the Lima date the range opens on", async () => {
      const workbook = await activityReport(
        tenant.tenantId,
        limaDayBounds("2026-09-19"),
      );

      expect(workbook.SheetNames).toEqual(["2026-09-19"]);
    });
  });

  describe("today's contact count", () => {
    it("counts activity since Lima midnight, not UTC midnight", async () => {
      // 22:00 on the 18th in Lima, already the 19th in UTC.
      vi.setSystemTime(new Date("2026-09-19T03:00:00.000Z"));
      await setLastActivity(tenant, Date.parse("2026-09-18T12:00:00-05:00"));

      expect(await ReportService.getTodayContactCount(tenant.tenantId)).toBe(1);
    });

    it("leaves out activity from the Lima day before", async () => {
      // Now is 00:30 on the 19th in Lima. The activity at 20:00 on the 18th in
      // Lima is already past UTC midnight, so a UTC cutoff would count it.
      vi.setSystemTime(new Date("2026-09-19T05:30:00.000Z"));
      await setLastActivity(tenant, Date.parse("2026-09-18T20:00:00-05:00"));

      expect(await ReportService.getTodayContactCount(tenant.tenantId)).toBe(0);
    });
  });

  describe("the activity timestamp a conversation is written with", () => {
    it("is an integer after a turn refreshes it", async () => {
      const before = Date.now();
      await refreshLastActivity(tenant.ref(CUSTOMER));

      const stored = await lastActivity(tenant);
      expect(typeof stored).toBe("number");
      expect(stored as number).toBeGreaterThanOrEqual(before);
    });

    it("is an integer after the conversation is released", async () => {
      const before = Date.now();
      await release(tenant.ref(CUSTOMER));

      const stored = await lastActivity(tenant);
      expect(typeof stored).toBe("number");
      expect(stored as number).toBeGreaterThanOrEqual(before);
    });

    it("is an integer after an agent takes the conversation over", async () => {
      const agent = await insertUser({ name: "Agent" });

      const before = Date.now();
      await takeoverConversation(tenant.ref(CUSTOMER), agent);

      const stored = await lastActivity(tenant);
      expect(typeof stored).toBe("number");
      expect(stored as number).toBeGreaterThanOrEqual(before);

      await run(
        "UPDATE conversations SET assigned_agent = NULL WHERE assigned_agent = ?",
        [agent],
      );
      await run("DELETE FROM audit_log WHERE user_id = ?", [agent]);
      await run("DELETE FROM users WHERE id = ?", [agent]);
    });

    it("lands inside today's activity report", async () => {
      await setLastActivity(tenant, 0);
      await refreshLastActivity(tenant.ref(CUSTOMER));

      expect(await dayRows(tenant.tenantId)).toBe(1);
    });
  });
});
