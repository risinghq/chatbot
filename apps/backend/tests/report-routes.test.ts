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
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

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

  describe("access", () => {
    it("still turns away a role that may not read reports", async () => {
      const agent = await login(tenant, "sales_agent");

      expect((await get("/api/reports/activity", agent)).status).toBe(403);
      expect((await get("/api/reports/today-count", agent)).status).toBe(403);
    });

    it("still needs a session", async () => {
      expect((await get("/api/reports/activity", {})).status).toBe(401);
    });
  });
});
