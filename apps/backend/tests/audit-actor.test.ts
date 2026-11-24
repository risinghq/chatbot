/** Who an audit row names, and how the history shows it, including a row no user wrote. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { HistoryEntry } from "@vendeya/types";

import { batch, getAll, run } from "./helpers/db.ts";
import {
  createMember,
  createTenantFixture,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import adminRoutes from "../src/routes/admin.ts";
import historyRoutes from "../src/routes/history.ts";
import { cliAuditStatement, logAction } from "../src/platform/audit/logger.ts";
import {
  businessHistory,
  platformHistory,
} from "../src/domains/history/index.ts";

const SOMEONE = { name: "someone", uid: 1000 };
const PAGE = { limit: 500, offset: 0 };

type AuditRow = {
  id: string;
  tenant_id: string | null;
  user_id: string | null;
  actor: string;
  action: string;
};

async function rowsFor(action: string): Promise<AuditRow[]> {
  return (await getAll(
    "SELECT id, tenant_id, user_id, actor, action FROM audit_log WHERE action = ?",
    [action],
  )) as AuditRow[];
}

async function login(
  userId: string,
  tenantId: string,
): Promise<Record<string, string>> {
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);
  return { Cookie: `session=${token}`, "X-Tenant-Id": tenantId };
}

describe("audit actors", () => {
  let tenant: TenantFixture;
  let action: string;

  beforeEach(async () => {
    tenant = await createTenantFixture("actors");
    action = `test.${crypto.randomUUID()}`;
  });

  afterEach(async () => {
    await run("DELETE FROM audit_log WHERE action = ?", [action]);
  });

  describe("logAction", () => {
    it("writes the acting user as user:<id>", async () => {
      const { userId } = await createMember(tenant);

      await logAction(
        { userId, tenantId: tenant.tenantId },
        action,
        "thing",
        "t1",
        { a: 1 },
      );

      const [row, ...rest] = await rowsFor(action);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        tenant_id: tenant.tenantId,
        user_id: userId,
        actor: `user:${userId}`,
      });
    });
  });

  describe("the history", () => {
    const mine = async (): Promise<HistoryEntry[]> =>
      (await businessHistory(tenant.tenantId, PAGE)).filter(
        (entry) => entry.action === action,
      );

    it("names a terminal command's operator, without the cli: prefix", async () => {
      await batch([
        cliAuditStatement(SOMEONE, tenant.tenantId, action, "user", "u-x", {
          email: "maria@example.com",
        }),
      ]);

      const [entry] = await mine();

      expect(entry?.actor).toEqual({ kind: "terminal", name: "someone" });
      expect(entry?.details).toMatchObject({ email: "maria@example.com" });
    });

    it("names a user by their name", async () => {
      const { userId } = await createMember(tenant);
      await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");

      const [entry] = await mine();

      expect(entry?.actor).toEqual({
        kind: "user",
        userId,
        name: "Test User",
      });
    });

    it("gives a user with an empty name no name, so the page can say so", async () => {
      const { userId } = await createMember(tenant);
      await run("UPDATE users SET name = '' WHERE id = ?", [userId]);
      await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");

      const [entry] = await mine();

      expect(entry?.actor).toEqual({ kind: "user", userId, name: null });
    });

    it("labels a subject from its record, and a gone one from the recorded name", async () => {
      const { userId } = await createMember(tenant);
      const actor = { userId, tenantId: tenant.tenantId };
      await logAction(actor, action, "user", userId);
      await logAction(actor, action, "customer", "gone-id", { name: "Rosa" });
      await logAction(actor, action, "customer", "nameless-id");

      const subjects = (await mine()).map((entry) => entry.subject);

      expect(subjects).toContainEqual({
        type: "user",
        id: userId,
        label: "Test User",
      });
      expect(subjects).toContainEqual({
        type: "customer",
        id: "gone-id",
        label: "Rosa",
      });
      expect(subjects).toContainEqual({
        type: "customer",
        id: "nameless-id",
        label: null,
      });
    });

    it("does not label another business's record", async () => {
      const other = await createTenantFixture("actors-other");
      const { userId } = await createMember(tenant);
      await run(
        "INSERT INTO customers (id, tenant_id, name) VALUES (?, ?, 'Ajeno')",
        ["foreign-customer", other.tenantId],
      );
      await logAction(
        { userId, tenantId: tenant.tenantId },
        action,
        "customer",
        "foreign-customer",
      );

      const [entry] = await mine();

      expect(entry?.subject?.label).toBeNull();
    });

    it("keeps platform rows out of a business, and business rows out of the platform", async () => {
      const { userId } = await createMember(tenant);
      await logAction({ userId, tenantId: null }, action, "system");
      await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");

      const business = await mine();
      const platform = (await platformHistory(PAGE)).filter(
        (entry) => entry.action === action,
      );

      expect(business.map((e) => e.subject)).toEqual([null]);
      expect(business).toHaveLength(1);
      expect(platform).toHaveLength(1);
      expect(platform[0]!.id).not.toBe(business[0]!.id);
    });

    it("refuses a sales agent", async () => {
      const { userId } = await createMember(tenant, "sales_agent");
      const app = new Hono();
      app.use("/api/*", requireAuth);
      app.route("/api/history", historyRoutes);

      const response = await app.request("/api/history", {
        headers: await login(userId, tenant.tenantId),
      });

      expect(response.status).toBe(403);
    });
  });

  describe("empty query filters", () => {
    it("ignores ?phone= on llm-errors", async () => {
      const { userId } = await createMember(tenant);
      const llmId = crypto.randomUUID();
      await run(
        `INSERT INTO llm_calls
           (id, tenant_id, channel_account_id, phone_number, operation, model,
            prompt, user_message, status, error_message, latency_ms)
         VALUES (?, ?, ?, ?, 'classify', 'test-model', 'p', 'm', 'error', 'boom', 5)`,
        [llmId, tenant.tenantId, tenant.channelAccountId, "51900000001"],
      );

      const app = new Hono();
      app.use("/api/*", requireAuth);
      app.use("/api/admin/*", requireRole("admin"));
      app.route("/api/admin", adminRoutes);

      const errors = (await (
        await app.request("/api/admin/llm-errors?phone=", {
          headers: await login(userId, tenant.tenantId),
        })
      ).json()) as { errors: Array<{ id: string }> };
      expect(errors.errors.map((e) => e.id)).toContain(llmId);
    });
  });

  it("cannot lose a row's user, because D1 refuses to delete a user an audit row names", async () => {
    const { userId } = await createMember(tenant);
    await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");

    await expect(
      run("DELETE FROM users WHERE id = ?", [userId]),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
