/**
 * An API token lets a program act as the person who minted it, under the same
 * role and tenant checks as their browser login, and no further.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import { getOne, run } from "./helpers/db.ts";
import { createMember, createTenantFixture } from "./helpers/tenancy.ts";
import { hashPassword } from "../src/platform/auth/password.ts";
import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import {
  API_TOKEN_PREFIX,
  createApiToken,
} from "../src/platform/auth/api-tokens.ts";
import authRoutes from "../src/routes/auth.ts";
import tenantRoutes from "../src/routes/tenants.ts";
import invitationRoutes from "../src/routes/admin/invitations.ts";

function buildApp() {
  const app = new Hono();
  app.route("/api/auth", authRoutes);
  app.use("/api/*", requireAuth);
  app.route("/api/tenants", tenantRoutes);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin/invitations", invitationRoutes);
  app.onError(errorHandler);
  return app;
}

type Credentials = { cookie?: string; bearer?: string };

describe("API tokens", () => {
  let app: ReturnType<typeof buildApp>;
  let tenantId: string;
  let userId: string;
  let cookie: string;

  beforeEach(async () => {
    app = buildApp();
    tenantId = (await createTenantFixture("Tokens")).tenantId;
    userId = (await createMember({ tenantId }, "admin")).userId;
    const token = generateSessionToken();
    await createSession(token, userId, tenantId);
    cookie = `session=${token}`;
  });

  function send(
    method: string,
    path: string,
    credentials: Credentials,
    body?: unknown,
  ) {
    return app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": crypto.randomUUID(),
        ...(credentials.cookie && {
          Cookie: credentials.cookie,
          "X-Tenant-Id": tenantId,
        }),
        ...(credentials.bearer && {
          Authorization: `Bearer ${credentials.bearer}`,
        }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  async function mint(name = "agent"): Promise<{ id: string; token: string }> {
    const response = await send(
      "POST",
      "/api/auth/tokens",
      { cookie },
      { name },
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; token: string };
  }

  it("mints a token from a browser login that acts as its owner in the same business", async () => {
    const { token } = await mint();
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);

    const me = await send("GET", "/api/auth/me", { bearer: token });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      user: { id: string; lastTenantId: string; role: string };
    };
    expect(body.user).toMatchObject({
      id: userId,
      lastTenantId: tenantId,
      role: "admin",
    });

    const invite = await send(
      "POST",
      "/api/admin/invitations",
      { bearer: token },
      { email: `${crypto.randomUUID()}@test.invalid`, role: "sales_agent" },
    );
    expect(invite.status).toBe(201);
  });

  it("stores only the token's hash", async () => {
    const { id, token } = await mint();
    const stored = await getOne<{ id: string }>(
      "SELECT id FROM session WHERE kind = 'token' AND user_id = ?",
      [userId],
    );
    expect(stored?.id).toBe(id);
    expect(id).not.toContain(token);
  });

  it("is refused as a cookie, and a cookie value is refused as a bearer token", async () => {
    const { token } = await mint();
    expect(
      (await send("GET", "/api/auth/me", { cookie: `session=${token}` }))
        .status,
    ).toBe(401);

    const browserToken = cookie.slice("session=".length);
    expect(
      (await send("GET", "/api/auth/me", { bearer: browserToken })).status,
    ).toBe(401);
  });

  it("judges a request by its bearer token even when it carries a cookie", async () => {
    const response = await send("GET", "/api/auth/me", {
      cookie,
      bearer: `${API_TOKEN_PREFIX}nonsense`,
    });
    expect(response.status).toBe(401);
  });

  it("cannot mint another token or change the password", async () => {
    const { token } = await mint();

    const minted = await send(
      "POST",
      "/api/auth/tokens",
      { bearer: token },
      { name: "child" },
    );
    expect(minted.status).toBe(403);

    const password = await send(
      "POST",
      "/api/auth/me/password",
      { bearer: token },
      { currentPassword: "x", newPassword: "a long enough password" },
    );
    expect(password.status).toBe(403);
  });

  it("keeps the role of its owner: a sales agent's token cannot reach admin routes", async () => {
    const agent = await createMember({ tenantId }, "sales_agent");
    const { token } = await createApiToken(
      agent.userId,
      { name: "agent", days: 1 },
      tenantId,
    );

    const invite = await send(
      "POST",
      "/api/admin/invitations",
      { bearer: token },
      { email: `${crypto.randomUUID()}@test.invalid`, role: "admin" },
    );
    expect(invite.status).toBe(403);
  });

  it("acts only in its own business, even for an owner of another", async () => {
    const other = (await createTenantFixture("Otra")).tenantId;
    await run(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES (?, ?, ?, 'admin')`,
      [crypto.randomUUID(), other, userId],
    );
    const { token } = await mint();
    const meIn = (business: string) =>
      app.request("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}`, "X-Tenant-Id": business },
      });

    expect((await meIn(other)).status).toBe(404);
    const own = await meIn(tenantId);
    expect(own.status).toBe(200);
    const { user } = (await own.json()) as { user: { lastTenantId: string } };
    expect(user.lastTenantId).toBe(tenantId);
  });

  it("made without a business, names one on each request and records none", async () => {
    const { token } = await createApiToken(
      userId,
      { name: "cli", days: 30 },
      null,
    );
    const inviteIn = (business?: string) =>
      app.request("/api/admin/invitations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(business && { "X-Tenant-Id": business }),
        },
        body: JSON.stringify({
          email: `${crypto.randomUUID()}@test.invalid`,
          role: "sales_agent",
        }),
      });

    expect((await inviteIn()).status).toBe(403);
    expect((await inviteIn(tenantId)).status).toBe(201);
    const stranger = (await createTenantFixture("Ajena")).tenantId;
    expect((await inviteIn(stranger)).status).toBe(404);

    const me = await send("GET", "/api/auth/me", { bearer: token });
    const { user } = (await me.json()) as {
      user: { lastTenantId: string | null };
    };
    expect(user.lastTenantId).toBeNull();
  });

  it("stays bound to its business while that business is suspended", async () => {
    const other = (await createTenantFixture("Otra")).tenantId;
    await run(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES (?, ?, ?, 'admin')`,
      [crypto.randomUUID(), other, userId],
    );
    const { token } = await mint();
    const invite = (business?: string) =>
      app.request("/api/admin/invitations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(business && { "X-Tenant-Id": business }),
        },
        body: JSON.stringify({
          email: `${crypto.randomUUID()}@test.invalid`,
          role: "sales_agent",
        }),
      });

    await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
      tenantId,
    ]);
    expect((await invite()).status).toBe(403);
    expect((await invite(other)).status).toBe(404);

    await run("UPDATE tenants SET status = 'active' WHERE id = ?", [tenantId]);
    expect((await invite()).status).toBe(201);
  });

  it("lists the owner's tokens without the secret, and revokes one", async () => {
    const { id, token } = await mint("ci");

    const list = await send("GET", "/api/auth/tokens", { cookie });
    const tokens = (await list.json()) as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ id, name: "ci" });
    expect(tokens[0]).not.toHaveProperty("token");

    expect(
      (await send("DELETE", `/api/auth/tokens/${id}`, { cookie })).status,
    ).toBe(200);
    expect((await send("GET", "/api/auth/me", { bearer: token })).status).toBe(
      401,
    );
    const audit = await getOne<{ metadata: string }>(
      "SELECT metadata FROM audit_log WHERE action = 'revoke_api_token' AND resource_id = ?",
      [id],
    );
    expect(JSON.parse(audit?.metadata ?? "{}")).toEqual({ name: "ci" });
  });

  it("cannot revoke another person's token", async () => {
    const other = await createMember({ tenantId }, "admin");
    const theirs = await createApiToken(
      other.userId,
      { name: "theirs", days: 1 },
      tenantId,
    );

    const response = await send("DELETE", `/api/auth/tokens/${theirs.id}`, {
      cookie,
    });
    expect(response.status).toBe(404);
    expect(
      (await send("GET", "/api/auth/me", { bearer: theirs.token })).status,
    ).toBe(200);
  });

  it("stops working at its expiry, without sliding", async () => {
    const { id, token } = await mint();
    await run("UPDATE session SET expires_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) - 1,
      id,
    ]);
    expect((await send("GET", "/api/auth/me", { bearer: token })).status).toBe(
      401,
    );
  });

  it("dies when its owner changes the password", async () => {
    await run("UPDATE users SET password_hash = ? WHERE id = ?", [
      await hashPassword("the old password!"),
      userId,
    ]);
    const { token } = await mint();

    const changed = await send(
      "POST",
      "/api/auth/me/password",
      { cookie },
      {
        currentPassword: "the old password!",
        newPassword: "a brand new password",
      },
    );
    expect(changed.status).toBe(200);
    expect((await send("GET", "/api/auth/me", { bearer: token })).status).toBe(
      401,
    );
  });

  it("refuses a nameless token and a lifetime over a year", async () => {
    expect(
      (await send("POST", "/api/auth/tokens", { cookie }, { name: " " }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(
          "POST",
          "/api/auth/tokens",
          { cookie },
          { name: "x", days: 366 },
        )
      ).status,
    ).toBe(400);
  });
});
