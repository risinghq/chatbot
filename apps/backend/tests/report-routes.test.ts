/**
 * The report routes answer an invalid date with 400 and a short
 * message, and cut their days in America/Lima whatever zone the server is in.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import process from "node:process";
import { Hono } from "hono";
import * as XLSX from "xlsx";
import { run } from "../src/db/index.ts";

import {
  createMember,
  createTenantFixture,
  fileOrder,
  insertConversation,
  insertUser,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import type { ReportSummary } from "@vendeya/types";

import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import reportRoutes from "../src/routes/reports.ts";

const CUSTOMER = "51900333444";

function buildApp() {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.route("/api/reports", reportRoutes);
  app.onError(errorHandler);
  return app;
}

async function login(
  tenant: TenantFixture,
  role: "admin" | "sales_agent" = "admin",
): Promise<{ Cookie: string }> {
  const { userId } = await createMember(tenant, role);
  const token = generateSessionToken();
  await createSession(token, userId, tenant.tenantId);
  return { Cookie: `session=${token}` };
}

function rowCount(buffer: ArrayBuffer): number {
  const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer" });
  const [name] = workbook.SheetNames;
  return XLSX.utils.sheet_to_json(workbook.Sheets[name ?? ""] ?? {}).length;
}

describe("report routes", () => {
  const originalTz = process.env.TZ;
  let app: ReturnType<typeof buildApp>;
  let tenant: TenantFixture;
  let auth: { Cookie: string };

  const get = (path: string, headers: Record<string, string> = auth) =>
    app.request(path, { headers });

  async function setLastActivity(at: number): Promise<void> {
    await run(
      `UPDATE conversations SET last_activity_at = ?
       WHERE tenant_id = ? AND phone_number = ?`,
      [at, tenant.tenantId, CUSTOMER],
    );
  }

  beforeAll(async () => {
    process.env.TZ = "UTC";
  });

  afterAll(async () => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  beforeEach(async () => {
    app = buildApp();
    tenant = await createTenantFixture("report-routes");
    await insertConversation(tenant.ref(CUSTOMER));
    auth = await login(tenant);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  describe("an invalid date", () => {
    it.each([
      [
        "/api/reports/activity?startDate=garbage",
        "startDate must be YYYY-MM-DD or an ISO timestamp with a zone",
      ],
      [
        "/api/reports/activity?startDate=2026-03-01&endDate=2026-13-01",
        "endDate must be YYYY-MM-DD or an ISO timestamp with a zone",
      ],
      [
        "/api/reports/orders?startDate=garbage",
        "startDate must be YYYY-MM-DD or an ISO timestamp with a zone",
      ],
      [
        "/api/reports/orders?startDate=2026-03-01&endDate=nope",
        "endDate must be YYYY-MM-DD or an ISO timestamp with a zone",
      ],
      [
        "/api/reports/orders?startDate=2026-04-31T00:00:00-05:00",
        "startDate must be YYYY-MM-DD or an ISO timestamp with a zone",
      ],
    ])("answers 400 with a short message: %s", async (path, message) => {
      const res = await get(path);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message });
    });
  });

  describe("the activity report", () => {
    const day = "/api/reports/activity?startDate=2026-09-19&endDate=2026-09-19";

    it("spans a Lima day from its midnight to its last millisecond", async () => {
      await setLastActivity(Date.parse("2026-09-19T00:00:00.000-05:00"));
      expect(rowCount(await (await get(day)).arrayBuffer())).toBe(1);

      await setLastActivity(Date.parse("2026-09-18T23:59:59.999-05:00"));
      expect(rowCount(await (await get(day)).arrayBuffer())).toBe(0);

      await setLastActivity(Date.parse("2026-09-19T23:59:59.999-05:00"));
      expect(rowCount(await (await get(day)).arrayBuffer())).toBe(1);
    });

    it("is today in Lima when no range is given", async () => {
      // 22:00 on the 19th in Lima, already the 20th in UTC.
      vi.setSystemTime(new Date("2026-09-20T03:00:00.000Z"));

      const res = await get("/api/reports/activity");

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBe(
        'attachment; filename="reporte-actividad-2026-09-19-a-2026-09-19.xlsx"',
      );
    });

    it("covers Lima days and is named for them", async () => {
      await setLastActivity(Date.parse("2026-03-10T23:30:00-05:00"));

      const res = await get(
        "/api/reports/activity?startDate=2026-03-09&endDate=2026-03-10",
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBe(
        'attachment; filename="reporte-actividad-2026-03-09-a-2026-03-10.xlsx"',
      );
      expect(rowCount(await res.arrayBuffer())).toBe(1);
    });

    it("leaves out the next Lima day", async () => {
      await setLastActivity(Date.parse("2026-03-11T00:00:00-05:00"));

      const res = await get(
        "/api/reports/activity?startDate=2026-03-09&endDate=2026-03-10",
      );

      expect(rowCount(await res.arrayBuffer())).toBe(0);
    });
  });

  describe("the orders report", () => {
    it("is named for the Lima days asked for", async () => {
      const res = await get(
        "/api/reports/orders?startDate=2026-03-09&endDate=2026-03-10",
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBe(
        'attachment; filename="reporte-ordenes-2026-03-09-a-2026-03-10.xlsx"',
      );
    });
  });

  describe("today's contact count", () => {
    it("counts the Lima day", async () => {
      // 22:00 on the 18th in Lima, already the 19th in UTC.
      vi.setSystemTime(new Date("2026-09-19T03:00:00.000Z"));
      await setLastActivity(Date.parse("2026-09-18T12:00:00-05:00"));

      const res = await get("/api/reports/today-count");

      expect(await res.json()).toEqual({ count: 1 });
    });
  });

  describe("the summary", () => {
    const at = (iso: string) => Date.parse(iso);

    async function inbound(phone: string, createdAt: number, ref = tenant) {
      await run(
        `INSERT INTO messages
           (id, tenant_id, channel_account_id, phone_number, direction, type, content, created_at)
         VALUES (?, ?, ?, ?, 'inbound', 'text', 'hola', ?)`,
        [
          crypto.randomUUID(),
          ref.tenantId,
          ref.channelAccountId,
          phone,
          createdAt,
        ],
      );
    }

    async function order(
      createdAt: number,
      options: {
        amountCents?: number;
        cancelled?: boolean;
        staff?: boolean;
      } = {},
      ref = tenant,
    ) {
      const filed = await fileOrder(ref.ref(CUSTOMER), {
        amountCents: options.amountCents,
        createdBy: options.staff ? (await createMember(ref)).userId : undefined,
      });
      await run(`UPDATE orders SET created_at = ?, status = ? WHERE id = ?`, [
        createdAt,
        options.cancelled ? "cancelled" : "confirmed",
        filed.id,
      ]);
    }

    async function modelCall(
      createdAt: number,
      model: string,
      tokens: [number, number],
      ref = tenant,
    ) {
      await run(
        `INSERT INTO llm_calls
           (id, tenant_id, channel_account_id, phone_number, operation, model,
            prompt, user_message, status, tokens_prompt, tokens_completion, created_at)
         VALUES (?, ?, ?, ?, 'assistant_turn', ?, '', '', 'success', ?, ?, ?)`,
        [
          crypto.randomUUID(),
          ref.tenantId,
          ref.channelAccountId,
          CUSTOMER,
          model,
          tokens[0],
          tokens[1],
          createdAt,
        ],
      );
    }

    it("sums contacts, orders and AI spend over the Lima days asked for", async () => {
      const other = "51900555666";
      await insertConversation(tenant.ref(other));
      const simulated = "51900777888";
      await insertConversation(tenant.ref(simulated), { isSimulation: true });

      // Two messages from one customer on one day are one contact.
      await inbound(CUSTOMER, at("2026-05-01T09:00:00-05:00"));
      await inbound(CUSTOMER, at("2026-05-01T23:59:59-05:00"));
      await inbound(CUSTOMER, at("2026-05-02T10:00:00-05:00"));
      await inbound(other, at("2026-05-02T00:00:00-05:00"));
      await inbound(simulated, at("2026-05-02T10:00:00-05:00"));
      // Outside the range.
      await inbound(other, at("2026-04-30T23:59:59-05:00"));

      await order(at("2026-05-01T12:00:00-05:00"), { amountCents: 10000 });
      await order(at("2026-05-02T12:00:00-05:00"), {
        amountCents: 5000,
        staff: true,
      });
      await order(at("2026-05-02T13:00:00-05:00"), {
        amountCents: 99900,
        cancelled: true,
      });
      await order(at("2026-05-03T00:00:00-05:00"), { amountCents: 77700 });

      await modelCall(
        at("2026-05-01T09:00:01-05:00"),
        "gpt-5-mini",
        [1_000_000, 100_000],
      );
      await modelCall(
        at("2026-05-02T09:00:01-05:00"),
        "gpt-4o-legacy",
        [500, 50],
      );

      const res = await get(
        "/api/reports/summary?startDate=2026-05-01&endDate=2026-05-02",
      );

      expect(res.status).toBe(200);
      const summary = (await res.json()) as ReportSummary;
      expect(summary.startDate).toBe("2026-05-01");
      expect(summary.endDate).toBe("2026-05-02");
      expect(summary.contacts).toBe(2);
      expect(summary.orders).toEqual({
        count: 2,
        cancelled: 1,
        revenueCents: 15000,
        averageCents: 7500,
        fromAssistant: 1,
        assistantRevenueCents: 10000,
        buyers: 1,
      });
      expect(summary.ai).toEqual({
        calls: 2,
        errors: 0,
        tokensPrompt: 1_000_500,
        tokensCompletion: 100_050,
        // 1M prompt tokens at 0.25 and 100k completion tokens at 2 per million.
        costUsd: 0.45,
        unpricedCalls: 1,
      });
      expect(summary.days).toEqual([
        { date: "2026-05-01", contacts: 1, orders: 1, revenueCents: 10000 },
        { date: "2026-05-02", contacts: 2, orders: 1, revenueCents: 5000 },
      ]);
      expect(summary.topProducts).toEqual([
        { name: "Producto de prueba", quantity: 2, revenueCents: 15000 },
      ]);
      expect(summary.businesses).toBeNull();
    });

    it("leaves out another business", async () => {
      const other = await createTenantFixture("report-routes-other");
      await insertConversation(other.ref(CUSTOMER));
      await inbound(CUSTOMER, at("2026-06-01T10:00:00-05:00"), other);
      await order(at("2026-06-01T11:00:00-05:00"), {}, other);

      const summary = (await (
        await get(
          "/api/reports/summary?startDate=2026-06-01&endDate=2026-06-01",
        )
      ).json()) as ReportSummary;

      expect(summary.contacts).toBe(0);
      expect(summary.orders.count).toBe(0);
    });

    it("gives the unpinned operator a line per business", async () => {
      const other = await createTenantFixture("report-routes-second");
      await insertConversation(other.ref(CUSTOMER));
      await inbound(CUSTOMER, at("2026-07-01T10:00:00-05:00"));
      await inbound(CUSTOMER, at("2026-07-01T10:00:00-05:00"), other);
      await order(
        at("2026-07-01T11:00:00-05:00"),
        { amountCents: 2000 },
        other,
      );
      await modelCall(at("2026-07-01T10:00:01-05:00"), "gpt-5", [0, 100_000]);

      const operator = await insertUser({ isPlatformOperator: true });
      const token = generateSessionToken();
      await createSession(token, operator, null);

      const summary = (await (
        await get(
          "/api/reports/summary?startDate=2026-07-01&endDate=2026-07-01",
          { Cookie: `session=${token}` },
        )
      ).json()) as ReportSummary;

      const line = (id: string) =>
        summary.businesses?.find((business) => business.tenantId === id);
      expect(line(tenant.tenantId)).toMatchObject({
        name: "report-routes",
        contacts: 1,
        orders: 0,
        aiCalls: 1,
        aiCostUsd: 1,
      });
      expect(line(other.tenantId)).toMatchObject({
        contacts: 1,
        orders: 1,
        revenueCents: 2000,
        aiCalls: 0,
      });
      expect(summary.contacts).toBeGreaterThanOrEqual(2);
    });

    it.each([
      [
        "/api/reports/summary?startDate=2026-05-02&endDate=2026-05-01",
        "endDate must not be before startDate",
      ],
      [
        "/api/reports/summary?startDate=2025-01-01&endDate=2026-01-02",
        "the range must be at most 366 days",
      ],
      [
        "/api/reports/summary?startDate=garbage",
        "startDate must be YYYY-MM-DD or an ISO timestamp with a zone",
      ],
    ])("answers 400 for %s", async (path, message) => {
      const res = await get(path);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message });
    });
  });

  describe("access", () => {
    it("still turns away a role that may not read reports", async () => {
      const agent = await login(tenant, "sales_agent");

      expect((await get("/api/reports/activity", agent)).status).toBe(403);
      expect((await get("/api/reports/today-count", agent)).status).toBe(403);
      expect((await get("/api/reports/summary", agent)).status).toBe(403);
    });

    it("still needs a session", async () => {
      expect((await get("/api/reports/activity", {})).status).toBe(401);
    });
  });
});
