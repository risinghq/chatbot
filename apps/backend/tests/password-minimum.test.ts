/**
 * Every route that sets a password enforces `MIN_PASSWORD_LENGTH`: signing up,
 * accepting an invitation, changing your own password, and an admin's reset.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { getOne, run } from "./helpers/db.ts";
import {
  createMember,
  createTenantFixture,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { MIN_PASSWORD_LENGTH } from "../src/domains/accounts/index.ts";
import { InvitationService } from "../src/domains/invitations/index.ts";
import { hashPassword } from "../src/platform/auth/password.ts";
import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import authRoutes from "../src/routes/auth.ts";
import adminUserRoutes from "../src/routes/admin/users.ts";

function buildApp() {
  const app = new Hono();
  app.route("/api/auth", authRoutes);
  app.use("/api/*", requireAuth);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin/users", adminUserRoutes);
  app.onError(errorHandler);
  return app;
}

const exactlyMinimum = "x".repeat(MIN_PASSWORD_LENGTH);
const oneShort = "x".repeat(MIN_PASSWORD_LENGTH - 1);
const NOT_A_STRING = 123456789012345;

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

async function hashOf(userId: string): Promise<string> {
  return (
    (await getOne("SELECT password_hash FROM users WHERE id = ?", [
      userId,
    ])) as { password_hash: string }
  ).password_hash;
}

async function accountFor(email: string) {
  return (await getOne("SELECT id FROM users WHERE email = ?", [email])) as
    | { id: string }
    | undefined;
}

function freshEmail(): string {
  return `${crypto.randomUUID()}@test.invalid`;
}

describe("the password minimum", () => {
  let app: ReturnType<typeof buildApp>;
  let tenant: TenantFixture;

  beforeEach(async () => {
    app = buildApp();
    tenant = await createTenantFixture("password-minimum");
  });

  function post(path: string, body: unknown, cookie?: string) {
    return app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie && { Cookie: cookie }),
      },
      body: JSON.stringify(body),
    });
  }

  async function login(userId: string): Promise<string> {
    const token = generateSessionToken();
    await createSession(token, userId, tenant.tenantId);
    return `session=${token}`;
  }

  describe("signing up", () => {
    function signUp(email: string, password: unknown) {
      return post("/api/auth/signup", {
        email,
        password,
        name: "Ana",
        businessName: "Tienda de Ana",
      });
    }

    it("refuses a password one character short, with the rule in the message", async () => {
      const email = freshEmail();

      const response = await signUp(email, oneShort);

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toContain(String(MIN_PASSWORD_LENGTH));
      expect(await accountFor(email)).toBeUndefined();
    });

    it("refuses a password that is not a string", async () => {
      const email = freshEmail();

      expect((await signUp(email, NOT_A_STRING)).status).toBe(400);
      expect(await accountFor(email)).toBeUndefined();
    });

    it("accepts a password of exactly the minimum", async () => {
      const email = freshEmail();

      expect((await signUp(email, exactlyMinimum)).status).toBe(200);
      expect(await accountFor(email)).toBeDefined();
    });
  });

  describe("accepting an invitation as a new account", () => {
    async function accept(password: unknown) {
      const email = freshEmail();
      const admin = await createMember(tenant, "admin");
      const invitation = await InvitationService.create(
        tenant.tenantId,
        { email, role: "sales_agent" },
        admin.userId,
      );
      if (!invitation.ok) throw invitation.error;

      const response = await post(
        `/api/auth/invitations/${invitation.value.token}/accept`,
        { name: "Nuevo", password },
      );
      return { response, email };
    }

    it("refuses a password one character short, with the rule in the message", async () => {
      const { response, email } = await accept(oneShort);

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toContain(String(MIN_PASSWORD_LENGTH));
      expect(await accountFor(email)).toBeUndefined();
    });

    it("refuses a password that is not a string", async () => {
      const { response, email } = await accept(NOT_A_STRING);

      expect(response.status).toBe(400);
      expect(await accountFor(email)).toBeUndefined();
    });

    it("accepts a password of exactly the minimum", async () => {
      const { response, email } = await accept(exactlyMinimum);

      expect(response.status).toBe(200);
      expect(await accountFor(email)).toBeDefined();
    });
  });

  describe("changing your own password", () => {
    const CURRENT = "the-current-password";
    let userId: string;
    let cookie: string;

    beforeEach(async () => {
      userId = (await createMember(tenant, "sales_agent")).userId;
      await run("UPDATE users SET password_hash = ? WHERE id = ?", [
        await hashPassword(CURRENT),
        userId,
      ]);
      cookie = await login(userId);
    });

    function change(newPassword: unknown) {
      return post(
        "/api/auth/me/password",
        { currentPassword: CURRENT, newPassword },
        cookie,
      );
    }

    it("refuses a password one character short, with the rule in the message", async () => {
      const before = await hashOf(userId);

      const response = await change(oneShort);

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toContain(String(MIN_PASSWORD_LENGTH));
      expect(await hashOf(userId)).toBe(before);
    });

    it("refuses a password that is not a string", async () => {
      const before = await hashOf(userId);

      expect((await change(NOT_A_STRING)).status).toBe(400);
      expect(await hashOf(userId)).toBe(before);
    });

    it("accepts a password of exactly the minimum", async () => {
      const before = await hashOf(userId);

      expect((await change(exactlyMinimum)).status).toBe(200);
      expect(await hashOf(userId)).not.toBe(before);
    });
  });

  describe("an admin resetting a member's password", () => {
    let cookie: string;

    beforeEach(async () => {
      cookie = await login((await createMember(tenant, "admin")).userId);
    });

    function reset(userId: string, newPassword: unknown) {
      return post(
        `/api/admin/users/${userId}/password`,
        { newPassword },
        cookie,
      );
    }

    it("refuses a password one character short, with the rule in the message", async () => {
      const member = (await createMember(tenant, "sales_agent")).userId;
      const before = await hashOf(member);

      const response = await reset(member, oneShort);

      expect(response.status).toBe(400);
      expect(await errorOf(response)).toContain(String(MIN_PASSWORD_LENGTH));
      expect(await hashOf(member)).toBe(before);
    });

    it("refuses a password that is not a string", async () => {
      const member = (await createMember(tenant, "sales_agent")).userId;
      const before = await hashOf(member);

      expect((await reset(member, NOT_A_STRING)).status).toBe(400);
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
