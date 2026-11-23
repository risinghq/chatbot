/** Who an audit row names, and the readers that show it, including a row no user wrote. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

import { batch, getAll, getOne, run } from "./helpers/db.ts";
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
import {
  cliAuditStatement,
  getAuditTrail,
  logAction,
} from "../src/platform/audit/logger.ts";
import { SystemLogService } from "../src/domains/system/logs.ts";

const SOMEONE = { name: "someone", uid: 1000 };

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
        {
          a: 1,
        },
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

  describe("readers", () => {
    let cliRowId: string;

    beforeEach(async () => {
      await batch([
        cliAuditStatement(
          SOMEONE,
          tenant.tenantId,
          action,
          "user",
          "u-target",
          {
            email: "maria@example.com",
          },
        ),
      ]);
      cliRowId = (await rowsFor(action))[0]!.id;
    });

    it("returns a row with no user from the trail", async () => {
      const row = (await getAuditTrail(tenant.tenantId)).find(
        (log) => log.id === cliRowId,
      );

      expect(row).toMatchObject({ user_id: null, actor: "cli:someone" });
    });

    it("shows the actor label where the system log would show a user name", async () => {
      const entry = (
        await SystemLogService.getRecentLogs(tenant.tenantId)
      ).find((log) => log.id === cliRowId);

      expect(entry?.actor).toBe("cli:someone");
      expect(entry?.summary).toBe("user u-target");
    });

    it("still shows a user's name for a user's row", async () => {
      const { userId } = await createMember(tenant);
      await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");
      const id = (await rowsFor(action)).find(
        (row) => row.user_id === userId,
      )!.id;

      const entry = (
        await SystemLogService.getRecentLogs(tenant.tenantId)
      ).find((log) => log.id === id);

      expect(entry?.actor).toBe(
        (
          (await getOne("SELECT name FROM users WHERE id = ?", [userId])) as {
            name: string;
          }
        ).name,
      );
    });

    it("answers the audit page with the label as the name, beside a user's row", async () => {
      const { userId } = await createMember(tenant);
      await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");

      const app = new Hono();
      app.use("/api/*", requireAuth);
      app.use("/api/admin/*", requireRole("admin"));
      app.route("/api/admin", adminRoutes);

      const response = await app.request("/api/admin/audit?limit=500", {
        headers: await login(userId, tenant.tenantId),
      });

      expect(response.status).toBe(200);
      const { logs } = (await response.json()) as {
        logs: Array<
          AuditRow & { user_name: string; user_email: string | null }
        >;
      };
      const mine = logs.filter((log) => log.action === action);

      const cli = mine.find((log) => log.id === cliRowId)!;
      expect(cli.user_id).toBeNull();
      expect(cli.actor).toBe("cli:someone");
      expect(cli.user_name).toBe("cli:someone");
      expect(cli.user_email).toBeNull();

      const person = mine.find((log) => log.user_id === userId)!;
      expect(person.user_name).toBe("Test User");
    });
  });

  describe("empty query filters", () => {
    it("ignores ?phone= on llm-errors and ?user_id= on audit", async () => {
      const { userId } = await createMember(tenant);
      const llmId = crypto.randomUUID();
      await run(
        `INSERT INTO llm_calls
           (id, tenant_id, channel_account_id, phone_number, operation, model,
            prompt, user_message, status, error_message, latency_ms)
         VALUES (?, ?, ?, ?, 'classify', 'test-model', 'p', 'm', 'error', 'boom', 5)`,
        [llmId, tenant.tenantId, tenant.channelAccountId, "51900000001"],
      );
      await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");

      const app = new Hono();
      app.use("/api/*", requireAuth);
      app.use("/api/admin/*", requireRole("admin"));
      app.route("/api/admin", adminRoutes);
      const cookie = await login(userId, tenant.tenantId);

      const errors = (await (
        await app.request("/api/admin/llm-errors?phone=", {
          headers: cookie,
        })
      ).json()) as { errors: Array<{ id: string }> };
      expect(errors.errors.map((e) => e.id)).toContain(llmId);

      const audit = (await (
        await app.request("/api/admin/audit?user_id=", {
          headers: cookie,
        })
      ).json()) as { logs: Array<{ action: string }> };
      expect(audit.logs.map((l) => l.action)).toContain(action);
    });
  });

  describe("a row whose user does not resolve", () => {
    type AuditPageRow = AuditRow & {
      user_name: string;
      user_email: string | null;
    };

    async function auditPage(userId: string): Promise<AuditPageRow[]> {
      const app = new Hono();
      app.use("/api/*", requireAuth);
      app.use("/api/admin/*", requireRole("admin"));
      app.route("/api/admin", adminRoutes);

      const response = await app.request("/api/admin/audit?limit=500", {
        headers: await login(userId, tenant.tenantId),
      });

      expect(response.status).toBe(200);
      const { logs } = (await response.json()) as { logs: AuditPageRow[] };
      return logs.filter((log) => log.action === action);
    }

    it("cannot exist, because D1 refuses to delete a user an audit row names", async () => {
      const { userId } = await createMember(tenant);
      await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");

      await expect(
        run("DELETE FROM users WHERE id = ?", [userId]),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    });

    it("does not call a living user with an empty name deleted", async () => {
      const { userId } = await createMember(tenant);
      await run("UPDATE users SET name = '' WHERE id = ?", [userId]);
      await logAction({ userId, tenantId: tenant.tenantId }, action, "thing");

      const row = (await auditPage(userId)).find(
        (log) => log.user_id === userId,
      )!;

      expect(row.user_name).toBe(`user:${userId}`);
      expect(row.user_email).toMatch(/@test\.invalid$/);
    });
  });
});
