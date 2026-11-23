/**
 * How a person gets an account: by opening a business, or by accepting an
 * invitation to one. And how they look after it: their profile and password.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import { getAll, getOne, run } from "./helpers/db.ts";
import {
  createMember,
  createTenantFixture,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { InvitationService } from "../src/domains/invitations/index.ts";
import { hashPassword } from "../src/platform/auth/password.ts";
import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import authRoutes from "../src/routes/auth.ts";
import invitationRoutes from "../src/routes/admin/invitations.ts";

const PASSWORD = "a long enough password";

function buildApp() {
  const app = new Hono();
  app.route("/api/auth", authRoutes);
  app.use("/api/*", requireAuth);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin/invitations", invitationRoutes);
  app.onError(errorHandler);
  return app;
}

function freshEmail(): string {
  return `${crypto.randomUUID()}@test.invalid`;
}

/** The session cookie a login, signup or acceptance set. */
function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const token = /session=([^;]+)/.exec(header)?.[1];
  if (!token) throw new Error(`No session cookie in: ${header}`);
  return `session=${token}`;
}

async function withPassword(userId: string, password: string) {
  await run("UPDATE users SET password_hash = ? WHERE id = ?", [
    await hashPassword(password),
    userId,
  ]);
}

async function emailOf(userId: string): Promise<string> {
  return (await getOne<{ email: string }>(
    "SELECT email FROM users WHERE id = ?",
    [userId],
  ))!.email;
}

describe("account routes", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  function send(method: string, path: string, body?: unknown, cookie?: string) {
    return app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        // The login limiter counts per address; each request gets its own.
        "cf-connecting-ip": crypto.randomUUID(),
        ...(cookie && { Cookie: cookie }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  describe("signing up", () => {
    it("opens a business with its founder as admin and logs them in", async () => {
      const email = freshEmail();

      const response = await send("POST", "/api/auth/signup", {
        email,
        password: PASSWORD,
        name: "Ana",
        businessName: "Tienda de Ana",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        user: { email: string; role: string; activeTenantId: string };
        tenants: Array<{ id: string; name: string; role: string }>;
      };
      expect(body.user.email).toBe(email);
      expect(body.user.role).toBe("admin");
      expect(body.tenants).toEqual([
        { id: body.user.activeTenantId, name: "Tienda de Ana", role: "admin" },
      ]);

      const me = await send(
        "GET",
        "/api/auth/me",
        undefined,
        sessionCookie(response),
      );
      expect(me.status).toBe(200);
    });

    it("refuses an email that already has an account, whatever its case", async () => {
      const email = freshEmail();
      const first = {
        email,
        password: PASSWORD,
        name: "Ana",
        businessName: "Uno",
      };
      expect((await send("POST", "/api/auth/signup", first)).status).toBe(200);

      const again = await send("POST", "/api/auth/signup", {
        ...first,
        email: email.toUpperCase(),
        businessName: "Dos",
      });

      expect(again.status).toBe(409);
      expect(
        await getAll(
          `SELECT t.name FROM tenants t
           JOIN tenant_memberships m ON m.tenant_id = t.id
           JOIN users u ON u.id = m.user_id
           WHERE u.email = ?`,
          [email],
        ),
      ).toEqual([{ name: "Uno" }]);
    });

    it("refuses a missing business name and leaves no account behind", async () => {
      const email = freshEmail();

      const response = await send("POST", "/api/auth/signup", {
        email,
        password: PASSWORD,
        name: "Ana",
        businessName: "  ",
      });

      expect(response.status).toBe(400);
      expect(
        await getOne("SELECT 1 FROM users WHERE email = ?", [email]),
      ).toBeUndefined();
    });
  });

  describe("invitations", () => {
    let tenant: TenantFixture;
    let adminCookie: string;

    beforeEach(async () => {
      tenant = await createTenantFixture("invitations");
      const admin = await createMember(tenant, "admin");
      const token = generateSessionToken();
      await createSession(token, admin.userId, tenant.tenantId);
      adminCookie = `session=${token}`;
    });

    async function invite(
      email: string,
      role = "sales_agent",
    ): Promise<string> {
      const response = await send(
        "POST",
        "/api/admin/invitations",
        { email, role },
        adminCookie,
      );
      expect(response.status).toBe(201);
      const { link } = (await response.json()) as { link: string };
      return link.split("/").pop()!;
    }

    it("lets a new person join with a name and password, and logs them in", async () => {
      const email = freshEmail();
      const token = await invite(email);

      const preview = await send("GET", `/api/auth/invitations/${token}`);
      expect(await preview.json()).toMatchObject({
        email,
        role: "sales_agent",
        hasAccount: false,
      });

      const accepted = await send(
        "POST",
        `/api/auth/invitations/${token}/accept`,
        {
          name: "Nuevo",
          password: PASSWORD,
        },
      );

      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as {
        user: { role: string; activeTenantId: string };
      };
      expect(body.user).toMatchObject({
        role: "sales_agent",
        activeTenantId: tenant.tenantId,
      });
    });

    it("lets an existing account join with its own password", async () => {
      const other = await createTenantFixture("invitations-other");
      const { userId } = await createMember(other, "admin");
      await withPassword(userId, PASSWORD);
      const token = await invite(await emailOf(userId), "supervisor");

      const preview = await send("GET", `/api/auth/invitations/${token}`);
      expect(await preview.json()).toMatchObject({ hasAccount: true });

      const wrong = await send(
        "POST",
        `/api/auth/invitations/${token}/accept`,
        {
          password: "not the password",
        },
      );
      expect(wrong.status).toBe(401);

      const accepted = await send(
        "POST",
        `/api/auth/invitations/${token}/accept`,
        {
          password: PASSWORD,
        },
      );
      expect(accepted.status).toBe(200);
      expect(
        await getOne(
          "SELECT role FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?",
          [tenant.tenantId, userId],
        ),
      ).toEqual({ role: "supervisor" });
    });

    it("works once", async () => {
      const token = await invite(freshEmail());
      const accept = () =>
        send("POST", `/api/auth/invitations/${token}/accept`, {
          name: "Nuevo",
          password: PASSWORD,
        });

      expect((await accept()).status).toBe(200);
      expect((await accept()).status).toBe(404);
      expect((await send("GET", `/api/auth/invitations/${token}`)).status).toBe(
        404,
      );
    });

    it("stops working when the admin revokes it", async () => {
      const email = freshEmail();
      const token = await invite(email);
      const list = (await (
        await send("GET", "/api/admin/invitations", undefined, adminCookie)
      ).json()) as { invitations: Array<{ id: string; email: string }> };
      const id = list.invitations.find((i) => i.email === email)!.id;

      const revoked = await send(
        "DELETE",
        `/api/admin/invitations/${id}`,
        undefined,
        adminCookie,
      );

      expect(revoked.status).toBe(200);
      expect((await send("GET", `/api/auth/invitations/${token}`)).status).toBe(
        404,
      );
    });

    it("keeps only the latest link for the same email", async () => {
      const email = freshEmail();
      const first = await invite(email);
      const second = await invite(email);

      expect((await send("GET", `/api/auth/invitations/${first}`)).status).toBe(
        404,
      );
      expect(
        (await send("GET", `/api/auth/invitations/${second}`)).status,
      ).toBe(200);
    });

    it("refuses to invite someone who is already a member", async () => {
      const { userId } = await createMember(tenant, "sales_agent");

      const response = await send(
        "POST",
        "/api/admin/invitations",
        { email: await emailOf(userId), role: "sales_agent" },
        adminCookie,
      );

      expect(response.status).toBe(409);
    });

    it("is purged once it expires unaccepted", async () => {
      const email = freshEmail();
      const created = await InvitationService.create(
        tenant.tenantId,
        { email, role: "sales_agent" },
        (await createMember(tenant, "admin")).userId,
      );
      if (!created.ok) throw created.error;

      await InvitationService.purgeExpired(
        Date.now() + 8 * 24 * 60 * 60 * 1000,
      );

      expect(
        await getOne("SELECT 1 FROM invitations WHERE id = ?", [
          created.value.id,
        ]),
      ).toBeUndefined();
    });
  });

  describe("your own account", () => {
    let tenant: TenantFixture;
    let userId: string;

    beforeEach(async () => {
      tenant = await createTenantFixture("own-account");
      userId = (await createMember(tenant, "sales_agent")).userId;
      await withPassword(userId, PASSWORD);
    });

    async function login(): Promise<string> {
      const response = await send("POST", "/api/auth/login", {
        email: await emailOf(userId),
        password: PASSWORD,
      });
      expect(response.status).toBe(200);
      return sessionCookie(response);
    }

    it("updates your name and phone number", async () => {
      const cookie = await login();

      const response = await send(
        "PATCH",
        "/api/auth/me",
        { name: "  Rosa  ", phoneNumber: "51900000002" },
        cookie,
      );

      expect(response.status).toBe(200);
      expect(
        await getOne("SELECT name, phone_number FROM users WHERE id = ?", [
          userId,
        ]),
      ).toEqual({ name: "Rosa", phone_number: "51900000002" });
    });

    it("refuses a password change with the wrong current password", async () => {
      const cookie = await login();

      const response = await send(
        "POST",
        "/api/auth/me/password",
        {
          currentPassword: "not the password",
          newPassword: "another long password",
        },
        cookie,
      );

      expect(response.status).toBe(400);
      expect(
        (
          await send("POST", "/api/auth/login", {
            email: await emailOf(userId),
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);
    });

    it("ends your other sessions when you change your password, and keeps this one", async () => {
      const other = await login();
      const current = await login();

      const response = await send(
        "POST",
        "/api/auth/me/password",
        { currentPassword: PASSWORD, newPassword: "another long password" },
        current,
      );

      expect(response.status).toBe(200);
      expect(
        (await send("GET", "/api/auth/me", undefined, current)).status,
      ).toBe(200);
      expect((await send("GET", "/api/auth/me", undefined, other)).status).toBe(
        401,
      );
    });
  });
});
