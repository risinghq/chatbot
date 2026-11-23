/** The six list routes read `limit` (and orders `offset`) through one reader that refuses anything but a plain in-range integer. */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import {
  createMember,
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import { logAction } from "../src/platform/audit/logger.ts";
import { batch, stmt } from "./helpers/db.ts";
import adminRoutes from "../src/routes/admin.ts";
import orderRoutes from "../src/routes/orders.ts";
import systemLogRoutes from "../src/routes/system-logs.ts";

const CUSTOMER = "51900777888";
const LIMIT_MESSAGE = "limit must be a whole number from 1 to 500";
const OFFSET_MESSAGE = "offset must be a whole number of 0 or more";

type Route = {
  name: string;
  path: string;
  fallback: number;
  seed(tenant: TenantFixture, userId: string, count: number): Promise<void>;
  count(body: unknown): number;
};

async function seedLlmCalls(
  tenant: TenantFixture,
  count: number,
  status: "success" | "error",
): Promise<void> {
  await batch(
    Array.from({ length: count }, () =>
      stmt(
        `INSERT INTO llm_calls
       (id, tenant_id, channel_account_id, phone_number, operation, model,
        prompt, user_message, status, error_message, latency_ms)
     VALUES (?, ?, ?, ?, 'classify', 'test-model', 'p', 'm', ?, 'boom', 5)`,
        [
          crypto.randomUUID(),
          tenant.tenantId,
          tenant.channelAccountId,
          CUSTOMER,
          status,
        ],
      ),
    ),
  );
}

const ROUTES: Route[] = [
  {
    name: "orders",
    path: "/api/orders",
    fallback: 50,
    async seed(tenant, _userId, count) {
      const customerId = crypto.randomUUID();
      await batch([
        stmt(
          "INSERT INTO customers (id, tenant_id, name, phone) VALUES (?, ?, 'Ana', ?)",
          [customerId, tenant.tenantId, CUSTOMER],
        ),
        ...Array.from({ length: count }, (_, i) =>
          stmt(
            `INSERT INTO orders
               (id, tenant_id, number, customer_id, channel_account_id, source,
                subtotal_cents, total_cents, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'assistant', 1000, 1000, ?, ?)`,
            [
              crypto.randomUUID(),
              tenant.tenantId,
              1001 + i,
              customerId,
              tenant.channelAccountId,
              Date.now() + i,
              Date.now() + i,
            ],
          ),
        ),
      ]);
    },
    count: (body) => (body as unknown[]).length,
  },
  {
    name: "system logs",
    path: "/api/system/logs",
    fallback: 100,
    seed: (tenant, _userId, count) => seedLlmCalls(tenant, count, "success"),
    count: (body) => (body as { logs: unknown[] }).logs.length,
  },
  {
    name: "llm errors",
    path: "/api/admin/llm-errors",
    fallback: 100,
    seed: (tenant, _userId, count) => seedLlmCalls(tenant, count, "error"),
    count: (body) => (body as { errors: unknown[] }).errors.length,
  },
  {
    name: "llm calls",
    path: "/api/admin/llm-calls",
    fallback: 50,
    seed: (tenant, _userId, count) => seedLlmCalls(tenant, count, "success"),
    count: (body) => (body as { calls: unknown[] }).calls.length,
  },
  {
    name: "audit",
    path: "/api/admin/audit",
    fallback: 100,
    async seed(tenant, userId, count) {
      for (let i = 0; i < count; i++) {
        await logAction(
          { userId, tenantId: tenant.tenantId },
          `test.${i}`,
          "thing",
        );
      }
    },
    count: (body) => (body as { logs: unknown[] }).logs.length,
  },
];

describe("limit and offset on the list routes", () => {
  let app: Hono;
  let tenant: TenantFixture;
  let userId: string;
  let auth: { Cookie: string; "X-Tenant-Id": string };

  const get = (path: string, query: string) =>
    app.request(`${path}?${query}`, { headers: auth });

  beforeEach(async () => {
    app = new Hono();
    app.use("/api/*", requireAuth);
    app.route("/api/orders", orderRoutes);
    app.use("/api/system/logs/*", requireRole("admin"));
    app.route("/api/system/logs", systemLogRoutes);
    app.use("/api/admin/*", requireRole("admin"));
    app.route("/api/admin", adminRoutes);
    app.onError(errorHandler);

    tenant = await createTenantFixture("list-paging");
    await insertConversation(tenant.ref(CUSTOMER));

    ({ userId } = await createMember(tenant, "admin"));
    const token = generateSessionToken();
    await createSession(token, userId, tenant.tenantId);
    auth = { Cookie: `session=${token}`, "X-Tenant-Id": tenant.tenantId };
  });

  describe.each(ROUTES)("$name", (route) => {
    it.each([
      "garbage",
      "-1",
      "0",
      "1.5",
      "1e2",
      "501",
      "+5",
      "12abc",
      "0x10",
      "%205",
      "99999999999999999999",
    ])("answers 400 for limit=%s", async (value) => {
      const response = await get(route.path, `limit=${value}`);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: LIMIT_MESSAGE });
    });

    it("takes limit=1 and limit=500", async () => {
      await route.seed(tenant, userId, route.fallback + 1);

      const one = await get(route.path, "limit=1");
      expect(one.status).toBe(200);
      expect(route.count(await one.json())).toBe(1);

      const most = await get(route.path, "limit=500");
      expect(most.status).toBe(200);
      expect(route.count(await most.json())).toBeGreaterThan(route.fallback);
    });

    it("uses the route's own default for an absent or empty limit", async () => {
      await route.seed(tenant, userId, route.fallback + 1);

      for (const query of ["", "limit="]) {
        const response = await get(route.path, query);

        expect(response.status).toBe(200);
        expect(route.count(await response.json())).toBe(route.fallback);
      }
    });
  });

  describe("orders offset", () => {
    const orders = ROUTES[0]!;

    it.each(["garbage", "-1", "1.5", "1e2", "+1", "0x10", "9007199254740992"])(
      "answers 400 for offset=%s",
      async (value) => {
        const response = await get(orders.path, `offset=${value}`);

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: OFFSET_MESSAGE });
      },
    );

    it("skips that many rows, and reads an absent, empty or zero offset as none", async () => {
      await orders.seed(tenant, userId, 3);

      for (const [query, expected] of [
        ["offset=1", 2],
        ["offset=3", 0],
        ["offset=0", 3],
        ["offset=", 3],
        ["", 3],
      ] as const) {
        const response = await get(orders.path, query);

        expect(response.status).toBe(200);
        expect(orders.count(await response.json())).toBe(expected);
      }
    });
  });
});
