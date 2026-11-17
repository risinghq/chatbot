/** The admin create and reset routes enforce `MIN_PASSWORD_LENGTH`. */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { getOne } from "../src/db/index.ts";
import {
  createMember,
  createTenantFixture,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { MIN_PASSWORD_LENGTH } from "../src/domains/accounts/index.ts";
import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import adminUserRoutes from "../src/routes/admin/users.ts";

function buildApp() {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin/users", adminUserRoutes);
  app.onError(errorHandler);
  return app;
}

describe("the password minimum on the admin user routes", () => {
  let app: ReturnType<typeof buildApp>;
  let tenant: TenantFixture;
  let cookie: string;

  const exactlyMinimum = "x".repeat(MIN_PASSWORD_LENGTH);
  const oneShort = "x".repeat(MIN_PASSWORD_LENGTH - 1);

  beforeEach(async () => {
    app = buildApp();
    tenant = await createTenantFixture("password-minimum");

    const admin = await createMember(tenant, "admin");
    const token = generateSessionToken();
    await createSession(token, admin.userId, tenant.tenantId);
    cookie = `session=${token}`;
  });

  function create(username: string, password: unknown) {
    return app.request("/api/admin/users", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        role: "sales_agent",
        name: "Nuevo",
      }),
    });
  }

  function reset(userId: string, newPassword: unknown) {
    return app.request(`/api/admin/users/${userId}/password`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword }),
    });
  }

  async function userNamed(username: string) {
    return (await getOne("SELECT id FROM users WHERE username = ?", [
      username,
    ])) as { id: string } | undefined;
  }

  async function hashOf(userId: string): Promise<string> {
    return (
      (await getOne("SELECT password_hash FROM users WHERE id = ?", [
        userId,
      ])) as { password_hash: string }
    ).password_hash;
  }

  describe("creating a user", () => {
    it("refuses a password one character short, with the rule in the message", async () => {
      const username = `short-${crypto.randomUUID().slice(0, 8)}`;

      const response = await create(username, oneShort);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(
        String(MIN_PASSWORD_LENGTH),
      );
      expect(await userNamed(username)).toBeUndefined();
    });

    it("refuses a password that is not a string", async () => {
      const username = `number-${crypto.randomUUID().slice(0, 8)}`;

      expect((await create(username, 123456789012345)).status).toBe(400);
      expect(await userNamed(username)).toBeUndefined();
    });

    it("accepts a password of exactly the minimum", async () => {
      const username = `exact-${crypto.randomUUID().slice(0, 8)}`;

      expect((await create(username, exactlyMinimum)).status).toBe(200);
      expect(await userNamed(username)).not.toBeNull();
    });
  });

  describe("resetting a password", () => {
    it("refuses a password one character short, with the rule in the message", async () => {
      const member = (await createMember(tenant, "sales_agent")).userId;
      const before = await hashOf(member);

      const response = await reset(member, oneShort);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(
        String(MIN_PASSWORD_LENGTH),
      );
      expect(await hashOf(member)).toBe(before);
    });

    it("refuses a password that is not a string", async () => {
      const member = (await createMember(tenant, "sales_agent")).userId;
      const before = await hashOf(member);

      expect((await reset(member, 123456789012345)).status).toBe(400);
      expect(await hashOf(member)).toBe(before);
    });

    it("accepts a password of exactly the minimum", async () => {
      const member = (await createMember(tenant, "sales_agent")).userId;
      const before = await hashOf(member);

      expect((await reset(member, exactlyMinimum)).status).toBe(200);
      expect(await hashOf(member)).not.toBe(before);
    });
  });
});
