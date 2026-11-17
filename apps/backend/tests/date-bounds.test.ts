/** Range queries and writes on the millisecond columns: the funnel, the daily report, `last_activity_at`. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as XLSX from "xlsx";

import { getOne, run } from "../src/db/index.ts";
import {
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { getFunnelStats } from "../src/domains/analytics/index.ts";
import { ReportService } from "../src/domains/reports/index.ts";
import { resetSession, updateConversation } from "../src/conversation/store.ts";
import { takeoverConversation } from "../src/domains/conversations/write.ts";

const CUSTOMER = "51900111222";

async function insertEvent(
  fixture: TenantFixture,
  createdAt: number,
): Promise<void> {
  await run(
    `INSERT INTO analytics_events
       (id, tenant_id, channel_account_id, phone_number, event_type, created_at)
     VALUES (?, ?, ?, ?, 'session_start', ?)`,
    [
      crypto.randomUUID(),
      fixture.tenantId,
      fixture.channelAccountId,
      CUSTOMER,
      createdAt,
    ],
  );
}

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

async function dailyReportRows(
  tenantId: string,
  date?: string,
): Promise<number> {
  const buffer = await ReportService.generateDailyReport(tenantId, date);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const [name] = workbook.SheetNames;
  return XLSX.utils.sheet_to_json(workbook.Sheets[name ?? ""] ?? {}).length;
}

// The dashboard's day is America/Lima, cut on a Worker whose clock is UTC.
describe("date ranges over millisecond columns", () => {
  let tenant: TenantFixture;

  beforeEach(async () => {
    tenant = await createTenantFixture("date-bounds");
    await insertConversation(tenant.ref(CUSTOMER), { clientName: "Ana" });
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  describe("the funnel", () => {
    it("counts an event inside an explicit range", async () => {
      const at = Date.parse("2026-03-10T15:00:00.000Z");
      await insertEvent(tenant, at);

      const stats = await getFunnelStats(
        tenant.tenantId,
        "2026-03-10T00:00:00.000Z",
        "2026-03-10T23:59:59.999Z",
      );

      expect(stats.sessions_started).toBe(1);
    });

    it("leaves out an event outside the range", async () => {
      await insertEvent(tenant, Date.parse("2026-03-11T00:00:01.000Z"));

      const stats = await getFunnelStats(
        tenant.tenantId,
        "2026-03-10T00:00:00.000Z",
        "2026-03-10T23:59:59.999Z",
      );

      expect(stats.sessions_started).toBe(0);
    });

    it("counts a recent event when no range is given", async () => {
      await insertEvent(tenant, Date.now() - 60_000);

      expect((await getFunnelStats(tenant.tenantId)).sessions_started).toBe(1);
    });

    describe("a date-only end", () => {
      it("covers the whole Lima day, including its evening", async () => {
        await insertEvent(tenant, Date.parse("2026-03-10T15:00:00.000Z"));
        await insertEvent(tenant, Date.parse("2026-03-10T23:30:00-05:00"));

        const stats = await getFunnelStats(
          tenant.tenantId,
          "2026-03-01",
          "2026-03-10",
        );

        expect(stats.sessions_started).toBe(2);
      });

      it("stops at the next Lima midnight", async () => {
        await insertEvent(tenant, Date.parse("2026-03-11T00:00:00-05:00"));

        const stats = await getFunnelStats(
          tenant.tenantId,
          "2026-03-01",
          "2026-03-10",
        );

        expect(stats.sessions_started).toBe(0);
      });
    });

    describe("a date-only start", () => {
      it("starts at Lima midnight", async () => {
        await insertEvent(tenant, Date.parse("2026-03-10T00:00:00-05:00"));

        const stats = await getFunnelStats(
          tenant.tenantId,
          "2026-03-10",
          "2026-03-10",
        );

        expect(stats.sessions_started).toBe(1);
      });

      it("leaves out the last moment of the day before", async () => {
        await insertEvent(tenant, Date.parse("2026-03-09T23:59:59.999-05:00"));

        const stats = await getFunnelStats(
          tenant.tenantId,
          "2026-03-10",
          "2026-03-10",
        );

        expect(stats.sessions_started).toBe(0);
      });
    });

    describe("a timestamp with a zone", () => {
      it("keeps its exact instant at the start", async () => {
        await insertEvent(tenant, Date.parse("2026-03-10T11:59:59.999Z"));
        await insertEvent(tenant, Date.parse("2026-03-10T12:00:00.000Z"));

        const stats = await getFunnelStats(
          tenant.tenantId,
          "2026-03-10T12:00:00.000Z",
          "2026-03-10T23:59:59.999Z",
        );

        expect(stats.sessions_started).toBe(1);
      });

      it("keeps its exact instant at the end", async () => {
        await insertEvent(tenant, Date.parse("2026-03-10T12:00:00.000Z"));
        await insertEvent(tenant, Date.parse("2026-03-10T12:00:00.001Z"));

        const stats = await getFunnelStats(
          tenant.tenantId,
          "2026-03-10T00:00:00.000Z",
          "2026-03-10T12:00:00.000Z",
        );

        expect(stats.sessions_started).toBe(1);
      });
    });

    it("refuses a bound that is not a date", async () => {
      await expect(getFunnelStats(tenant.tenantId, "garbage")).rejects.toThrow(
        "start must be YYYY-MM-DD or an ISO timestamp with a zone",
      );
      await expect(
        getFunnelStats(tenant.tenantId, "2026-02-01", "2026-02-30"),
      ).rejects.toThrow(
        "end must be YYYY-MM-DD or an ISO timestamp with a zone",
      );
    });
  });

  describe("the daily report", () => {
    it("lists a conversation active that day", async () => {
      await setLastActivity(tenant, Date.parse("2026-03-10T12:00:00-05:00"));

      expect(await dailyReportRows(tenant.tenantId, "2026-03-10")).toBe(1);
    });

    it("leaves out a conversation active on another day", async () => {
      await setLastActivity(tenant, Date.parse("2026-03-11T12:00:00-05:00"));

      expect(await dailyReportRows(tenant.tenantId, "2026-03-10")).toBe(0);
    });

    it("opens at Lima midnight", async () => {
      await setLastActivity(
        tenant,
        Date.parse("2026-09-19T00:00:00.000-05:00"),
      );

      expect(await dailyReportRows(tenant.tenantId, "2026-09-19")).toBe(1);
    });

    it("leaves out the last moment of the Lima day before", async () => {
      await setLastActivity(
        tenant,
        Date.parse("2026-09-18T23:59:59.999-05:00"),
      );

      expect(await dailyReportRows(tenant.tenantId, "2026-09-19")).toBe(0);
    });

    it("closes on the last millisecond of the Lima day", async () => {
      await setLastActivity(
        tenant,
        Date.parse("2026-09-19T23:59:59.999-05:00"),
      );

      expect(await dailyReportRows(tenant.tenantId, "2026-09-19")).toBe(1);
    });

    it("leaves out Lima midnight of the next day", async () => {
      await setLastActivity(
        tenant,
        Date.parse("2026-09-20T00:00:00.000-05:00"),
      );

      expect(await dailyReportRows(tenant.tenantId, "2026-09-19")).toBe(0);
    });

    it("is today's Lima day when no date is given", async () => {
      vi.setSystemTime(new Date("2026-09-20T03:00:00.000Z"));
      await setLastActivity(tenant, Date.parse("2026-09-19T08:00:00-05:00"));

      expect(await dailyReportRows(tenant.tenantId)).toBe(1);
    });

    it("names its sheet for the Lima date", async () => {
      const buffer = await ReportService.generateDailyReport(
        tenant.tenantId,
        "2026-09-19",
      );

      expect(XLSX.read(buffer, { type: "buffer" }).SheetNames).toEqual([
        "2026-09-19",
      ]);
    });

    it("refuses a date that is not a calendar day", async () => {
      await expect(
        ReportService.generateDailyReport(tenant.tenantId, "garbage"),
      ).rejects.toThrow("date must be YYYY-MM-DD");
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
    it("is an integer after its state is saved", async () => {
      const before = Date.now();
      await updateConversation(tenant.ref(CUSTOMER), { phase: "greeting" }, {});

      const stored = await lastActivity(tenant);
      expect(typeof stored).toBe("number");
      expect(stored as number).toBeGreaterThanOrEqual(before);
    });

    it("is an integer after the session is reset", async () => {
      const before = Date.now();
      await resetSession(tenant.ref(CUSTOMER));

      const stored = await lastActivity(tenant);
      expect(typeof stored).toBe("number");
      expect(stored as number).toBeGreaterThanOrEqual(before);
    });

    it("is an integer after an agent takes the conversation over", async () => {
      const agent = `u-${crypto.randomUUID()}`;
      await run(
        `INSERT INTO users (id, username, password_hash, role, name)
         VALUES (?, ?, 'x', 'sales_agent', 'Agent')`,
        [agent, `agent-${agent.slice(2, 10)}`],
      );

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

    it("lands inside today's daily report", async () => {
      await updateConversation(tenant.ref(CUSTOMER), { phase: "greeting" }, {});

      expect(await dailyReportRows(tenant.tenantId)).toBe(1);
    });
  });
});
