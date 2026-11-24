/**
 * Authorization at the HTTP layer, through the real routers, the real
 * `requireAuth` and a real session cookie.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { hashPassword } from "../src/platform/auth/password.ts";
import { frontendPath, importFrontend } from "./helpers/frontend.ts";
import { page as kitPage } from "./helpers/sveltekit-app.ts";
import { getOne, run } from "./helpers/db.ts";
import type { Product } from "@vendeya/types";

import {
  addChannelAccount,
  createTenantFixture,
  fileOrder,
  insertConversation,
  insertTenant,
  insertUser,
  type TenantFixture,
  setCaliddaLogin,
  setChannelStatus,
  simulatorRef,
} from "./helpers/tenancy.ts";

import {
  activeTenantId,
  requireAuth,
  requireRole,
} from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  defaultTenantForUser,
  generateSessionToken,
  validateSessionToken,
} from "../src/platform/auth/session.ts";
import { hasRole, sessionRole } from "../src/platform/auth/scope.ts";
import conversationRoutes from "../src/routes/conversations.ts";
import catalogRoutes from "../src/routes/catalog.ts";
import orderRoutes from "../src/routes/orders.ts";
import assetRoutes from "../src/routes/assets.ts";
import tenantRoutes from "../src/routes/tenants.ts";
import platformRoutes from "../src/routes/platform.ts";
import authRoutes from "../src/routes/auth.ts";
import adminUserRoutes from "../src/routes/admin/users.ts";
import adminInvitationRoutes from "../src/routes/admin/invitations.ts";
import adminSystemRoutes from "../src/routes/admin/system.ts";
import adminChannelRoutes from "../src/routes/admin/channels.ts";
import {
  SystemSettings,
  TenantSettings,
} from "../src/domains/settings/system.ts";
import { TenantSecrets } from "../src/domains/settings/tenant-secrets.ts";
import { MembershipService } from "../src/domains/tenants/index.ts";
import { AssetService } from "../src/domains/assets/index.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import { VariantService } from "../src/domains/catalog/variants.ts";
import { StockService } from "../src/domains/stock/index.ts";
import { assignNextAgentHeld } from "../src/domains/conversations/assignment.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { PaymentMethodService } from "../src/domains/orders/settings.ts";

const SHARED_PHONE = "51987654321";

const ORDER_PAGE = frontendPath(
  "routes/dashboard/[tenantId=uuid]/orders/[orderId]/+page.svelte",
);
const { renderComponent } = await importFrontend<{
  renderComponent: (
    path: string,
    props: Record<string, unknown>,
  ) => Promise<string>;
}>("lib/testing/render.ts");

function buildApp() {
  const app = new Hono();
  // Mounted before the global requireAuth, as index.ts does. Of the routes
  // mounted here, only logging in needs no session.
  app.route("/api/auth", authRoutes);
  app.use("/api/*", requireAuth);
  app.route("/api/conversations", conversationRoutes);
  app.route("/api/catalog", catalogRoutes);
  app.route("/api/orders", orderRoutes);
  app.route("/api/assets", assetRoutes);
  app.route("/api/tenants", tenantRoutes);
  app.route("/api/platform", platformRoutes);
  // Mounted the way index.ts mounts them, admin gate included.
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin/users", adminUserRoutes);
  app.route("/api/admin/invitations", adminInvitationRoutes);
  app.route("/api/admin/channels", adminChannelRoutes);
  app.route("/api/admin", adminSystemRoutes);
  return app;
}

/** A browser session and the business its page is open on, if any. */
type Session = { cookie: string; tenantId?: string | null };

/** A logged-in user, as a cookie the app will accept, on a business page. */
async function login(
  userId: string,
  tenantId: string | null,
): Promise<{ cookie: string; token: string; tenantId: string | null }> {
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);
  return { cookie: `session=${token}`, token, tenantId };
}

/** The headers a dashboard page sends: the cookie and the business in its URL. */
function authHeaders(auth: Session): Record<string, string> {
  return {
    Cookie: auth.cookie,
    ...(auth.tenantId ? { "X-Tenant-Id": auth.tenantId } : {}),
  };
}

async function createUser(options: {
  tenantId?: string;
  role?: "admin" | "developer" | "supervisor" | "sales_agent";
  isPlatformOperator?: boolean;
}): Promise<string> {
  const role = options.role ?? "admin";
  const userId = await insertUser({
    isPlatformOperator: options.isPlatformOperator,
  });

  if (options.tenantId) {
    await run(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES (?, ?, ?, ?)`,
      [crypto.randomUUID(), options.tenantId, userId, role],
    );
  }

  return userId;
}

describe("HTTP authorization", () => {
  let app: ReturnType<typeof buildApp>;
  let alpha: TenantFixture;
  let beta: TenantFixture;

  let alphaAdmin: Awaited<ReturnType<typeof login>>;
  let betaAdmin: Awaited<ReturnType<typeof login>>;

  beforeEach(async () => {
    app = buildApp();

    alpha = await createTenantFixture("alpha-http");
    beta = await createTenantFixture("beta-http");

    alphaAdmin = await login(
      await createUser({ tenantId: alpha.tenantId }),
      alpha.tenantId,
    );
    betaAdmin = await login(
      await createUser({ tenantId: beta.tenantId }),
      beta.tenantId,
    );

    await insertConversation(alpha.ref(SHARED_PHONE), {
      clientName: "Alpha Client",
    });
    await insertConversation(beta.ref(SHARED_PHONE), {
      clientName: "Beta Client",
    });
  });

  function get(path: string, auth?: Session) {
    return app.request(path, {
      headers: auth ? authHeaders(auth) : {},
    });
  }

  /** GET a path and read the JSON body, typed by the caller. */
  async function getJson<T = any>(path: string, auth?: Session): Promise<T> {
    return (await (await get(path, auth)).json()) as Promise<T>;
  }

  function patch(path: string, auth: Session, body: unknown) {
    return app.request(path, {
      method: "PATCH",
      headers: { ...authHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function post(path: string, auth: Session, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { ...authHeaders(auth), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a request with no session", async () => {
    const response = await get("/api/conversations");
    expect(response.status).toBe(401);
  });

  it("serves each tenant its own copy of the same phone number", async () => {
    const fromAlpha = await getJson(
      `/api/conversations/${SHARED_PHONE}`,
      alphaAdmin,
    );
    const fromBeta = await getJson(
      `/api/conversations/${SHARED_PHONE}`,
      betaAdmin,
    );

    expect(fromAlpha.conversation.customer_name).toBe("Alpha Client");
    expect(fromAlpha.conversation.tenant_id).toBe(alpha.tenantId);
    expect(fromBeta.conversation.customer_name).toBe("Beta Client");
    expect(fromBeta.conversation.tenant_id).toBe(beta.tenantId);
  });

  it("lists only the caller's tenant's conversations", async () => {
    const rows = await getJson<Array<{ tenant_id: string }>>(
      "/api/conversations",
      alphaAdmin,
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((r: { tenant_id: string }) => r.tenant_id === alpha.tenantId),
    ).toBe(true);
  });

  it("404s a conversation that exists only in another tenant", async () => {
    const onlyInBeta = "51900000001";
    await insertConversation(beta.ref(onlyInBeta), { clientName: "Beta Only" });

    const response = await get(`/api/conversations/${onlyInBeta}`, alphaAdmin);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Conversation not found" });
  });

  it("does not leak another tenant's catalog", async () => {
    const betaProduct = await ProductService.create({
      tenantId: beta.tenantId,
      name: "Beta Product",
      category: "cocinas",
    });

    expect(
      await getJson<unknown[]>("/api/catalog/products", alphaAdmin),
    ).toEqual([]);
    expect(await getJson("/api/catalog/products", betaAdmin)).toHaveLength(1);

    // Even naming the other tenant's product explicitly finds nothing.
    expect(
      (await get(`/api/catalog/products/${betaProduct.id}`, alphaAdmin)).status,
    ).toBe(404);
  });

  /** The row as stored, read without a tenant filter so a moved row is still found. */
  async function storedProduct(id: string) {
    return (await getOne("SELECT * FROM products WHERE id = ?", [id])) as
      | Product
      | undefined;
  }

  /**
   * The product PATCH passes the request body to the service. The service must
   * drop off-list keys, because a new `tenant_id` would move the row to
   * another business.
   */
  it("ignores off-list fields in a product PATCH instead of moving the row", async () => {
    const product = await ProductService.create({
      tenantId: alpha.tenantId,
      name: "Alpha Product",
      category: "Cocinas",
    });

    const response = await patch(
      `/api/catalog/products/${product.id}`,
      alphaAdmin,
      { name: "Renamed", tenant_id: beta.tenantId, id: "hijacked-id" },
    );

    // Checked before the response is read: whatever the route answers, the row
    // must not have left the tenant that owns it.
    const stored = await storedProduct(product.id);
    expect(stored?.tenant_id).toBe(alpha.tenantId);

    // Dropped, not rejected: the request succeeds and the rename still lands.
    expect(response.status).toBe(200);
    expect(stored?.name).toBe("Renamed");
    expect(
      await getJson<unknown[]>("/api/catalog/products", betaAdmin),
    ).toEqual([]);
  });

  it("does not leak another tenant's orders", async () => {
    const betaOrder = await fileOrder(beta.ref(SHARED_PHONE), {
      name: "Beta Client",
    });

    expect(await getJson<unknown[]>("/api/orders", alphaAdmin)).toEqual([]);

    const byId = await get(`/api/orders/${betaOrder.id}`, alphaAdmin);
    expect(byId.status).toBe(404);

    expect(
      await getJson<{ order: unknown }>(
        `/api/orders/by-conversation/${SHARED_PHONE}`,
        alphaAdmin,
      ),
    ).toEqual({ order: null });

    // ...and the owner still sees it.
    const asOwner = await getJson<{ id: string }>(
      `/api/orders/${betaOrder.id}`,
      betaAdmin,
    );
    expect(asOwner.id).toBe(betaOrder.id);
  });

  it("does not resolve another tenant's private asset", async () => {
    const betaAsset = await AssetService.create({
      tenantId: beta.tenantId,
      kind: "contract",
      visibility: "private",
      storageKey: `${beta.tenantId}/contracts/x.pdf`,
    });

    const response = await get(`/api/assets/${betaAsset.id}`, alphaAdmin);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Asset not found" });
  });

  it("refuses a logged-in user who belongs to no tenant", async () => {
    const orphan = await login(await createUser({}), null);

    const conversations = await get("/api/conversations", orphan);
    expect(conversations.status).toBe(403);

    const catalog = await get("/api/catalog/products", orphan);
    expect(catalog.status).toBe(403);
  });

  it("closes a business to its page as soon as the membership is revoked", async () => {
    const userId = await createUser({ tenantId: alpha.tenantId });
    const session = await login(userId, alpha.tenantId);

    expect((await get("/api/conversations", session)).status).toBe(200);

    await run(
      "DELETE FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?",
      [alpha.tenantId, userId],
    );

    // Same cookie, no membership: the business is gone on the next request.
    expect((await get("/api/conversations", session)).status).toBe(404);
  });

  it("still lists and opens the membership a member keeps", async () => {
    const userId = await createUser({ tenantId: alpha.tenantId });
    await run(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES (?, ?, ?, 'admin')`,
      [crypto.randomUUID(), beta.tenantId, userId],
    );

    const session = await login(userId, alpha.tenantId);

    await run(
      "DELETE FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?",
      [alpha.tenantId, userId],
    );

    expect((await get("/api/conversations", session)).status).toBe(404);

    const listed = await getJson<{ tenants: Array<{ id: string }> }>(
      "/api/tenants",
      { cookie: session.cookie },
    );
    expect(listed.tenants.map((t) => t.id)).toEqual([beta.tenantId]);

    expect(
      (
        await get("/api/conversations", {
          cookie: session.cookie,
          tenantId: beta.tenantId,
        })
      ).status,
    ).toBe(200);
  });

  /**
   * An email is one account across the platform. Inviting it must not tell a
   * tenant admin whether another business already has that person.
   */
  describe("inviting an email another business already has", () => {
    function invite(auth: Session, email: string) {
      return app.request("/api/admin/invitations", {
        method: "POST",
        headers: { ...authHeaders(auth), "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: "sales_agent" }),
      });
    }

    it("answers like an invitation to a new address", async () => {
      const betaMember = await createUser({ tenantId: beta.tenantId });
      const { email: theirs } = (await getOne(
        "SELECT email FROM users WHERE id = ?",
        [betaMember],
      )) as { email: string };
      const fresh = `${crypto.randomUUID()}@test.invalid`;

      const elsewhere = await invite(alphaAdmin, theirs);
      const unknown = await invite(alphaAdmin, fresh);

      expect(elsewhere.status).toBe(201);
      expect(unknown.status).toBe(201);
      expect(Object.keys(await elsewhere.json()).sort()).toEqual(
        Object.keys(await unknown.json()).sort(),
      );
    });

    it("refuses an email that is already in this business", async () => {
      const alphaMember = await createUser({ tenantId: alpha.tenantId });
      const { email } = (await getOne("SELECT email FROM users WHERE id = ?", [
        alphaMember,
      ])) as { email: string };

      expect((await invite(alphaAdmin, email)).status).toBe(409);
    });
  });

  /**
   * `password_hash` lives on the global user record. Resetting it for a user who
   * also belongs to another tenant would give the acting admin that user's
   * access everywhere, which is a cross-tenant account takeover.
   */
  describe("password reset cannot become cross-tenant access", () => {
    async function hashOf(userId: string): Promise<string> {
      return (
        (await getOne("SELECT password_hash FROM users WHERE id = ?", [
          userId,
        ])) as { password_hash: string }
      ).password_hash;
    }

    function resetPassword(auth: Session, userId: string) {
      return app.request(`/api/admin/users/${userId}/password`, {
        method: "POST",
        headers: { ...authHeaders(auth), "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "a-new-password" }),
      });
    }

    it("refuses when the target also belongs to another tenant", async () => {
      const shared = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'sales_agent')`,
        [crypto.randomUUID(), beta.tenantId, shared],
      );

      const before = await hashOf(shared);
      const response = await resetPassword(alphaAdmin, shared);

      expect(response.status).toBe(403);
      expect(await hashOf(shared)).toBe(before);
    });

    it("still allows it for a user whose only tenant is this one", async () => {
      const own = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });
      const before = await hashOf(own);

      const response = await resetPassword(alphaAdmin, own);

      expect(response.status).toBe(200);
      expect(await hashOf(own)).not.toBe(before);
    });

    it("counts a membership in a suspended tenant too", async () => {
      const shared = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'sales_agent')`,
        [crypto.randomUUID(), beta.tenantId, shared],
      );
      // A suspended tenant can be reactivated, so the account still reaches it.
      await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
        beta.tenantId,
      ]);

      const before = await hashOf(shared);
      expect((await resetPassword(alphaAdmin, shared)).status).toBe(403);
      expect(await hashOf(shared)).toBe(before);
    });

    it("lets a platform operator reset a multi-tenant user's password", async () => {
      const shared = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'sales_agent')`,
        [crypto.randomUUID(), beta.tenantId, shared],
      );

      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        alpha.tenantId,
      );

      const before = await hashOf(shared);
      expect((await resetPassword(operator, shared)).status).toBe(200);
      expect(await hashOf(shared)).not.toBe(before);
    });

    it("still refuses a user who is not in the acting tenant at all", async () => {
      const betaOnly = await createUser({ tenantId: beta.tenantId });
      expect((await resetPassword(alphaAdmin, betaOnly)).status).toBe(404);
    });
  });

  /**
   * `is_active` is on the global user record too. Deactivating a user who also
   * belongs to another tenant would lock them out of that other business. The
   * rule is the same as for the password reset above.
   */
  describe("deactivation cannot reach another tenant", () => {
    async function isActive(userId: string): Promise<number> {
      return (
        (await getOne("SELECT is_active FROM users WHERE id = ?", [
          userId,
        ])) as {
          is_active: number;
        }
      ).is_active;
    }

    function toggleStatus(auth: Session, userId: string) {
      return app.request(`/api/admin/users/${userId}/status`, {
        method: "PATCH",
        headers: { ...authHeaders(auth) },
      });
    }

    /** A user who works for both businesses. */
    async function sharedUser(): Promise<string> {
      const userId = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'sales_agent')`,
        [crypto.randomUUID(), beta.tenantId, userId],
      );
      return userId;
    }

    it("refuses to deactivate a user who also belongs to another tenant", async () => {
      const shared = await sharedUser();

      const response = await toggleStatus(alphaAdmin, shared);

      expect(response.status).toBe(403);
      expect(await isActive(shared)).toBe(1);
    });

    it("leaves the shared user's session in the other tenant alone", async () => {
      const shared = await sharedUser();
      const theirSession = await login(shared, beta.tenantId);

      await toggleStatus(alphaAdmin, shared);

      // Still working in the tenant the acting admin has nothing to do with.
      expect((await get("/api/conversations", theirSession)).status).toBe(200);
    });

    it("refuses to reactivate one either", async () => {
      const shared = await sharedUser();
      await run("UPDATE users SET is_active = 0 WHERE id = ?", [shared]);

      const response = await toggleStatus(alphaAdmin, shared);

      expect(response.status).toBe(403);
      expect(await isActive(shared)).toBe(0);
    });

    it("counts a membership in a suspended tenant too", async () => {
      const shared = await sharedUser();
      await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
        beta.tenantId,
      ]);

      expect((await toggleStatus(alphaAdmin, shared)).status).toBe(403);
      expect(await isActive(shared)).toBe(1);
    });

    it("still allows it for a user whose only tenant is this one", async () => {
      const own = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });

      const response = await toggleStatus(alphaAdmin, own);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, is_active: 0 });
      expect(await isActive(own)).toBe(0);
    });

    it("lets a platform operator deactivate a multi-tenant user", async () => {
      const shared = await sharedUser();
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        alpha.tenantId,
      );

      expect((await toggleStatus(operator, shared)).status).toBe(200);
      expect(await isActive(shared)).toBe(0);
    });

    it("still refuses a user who is not in the acting tenant at all", async () => {
      const betaOnly = await createUser({ tenantId: beta.tenantId });
      expect((await toggleStatus(alphaAdmin, betaOnly)).status).toBe(404);
    });

    it("removing the membership is the tenant-scoped alternative", async () => {
      const shared = await sharedUser();

      const removed = await app.request(
        `/api/admin/users/${shared}/membership`,
        { method: "DELETE", headers: { ...authHeaders(alphaAdmin) } },
      );

      expect(removed.status).toBe(200);
      // Gone from this tenant, account and other tenant untouched.
      expect(await MembershipService.get(alpha.tenantId, shared)).toBeNull();
      expect(await MembershipService.get(beta.tenantId, shared)).not.toBeNull();
      expect(await isActive(shared)).toBe(1);
    });
  });

  /**
   * The browser drops the cookie at the expiry it got at login. A renewal moves
   * `expires_at` in the database, so the response must carry the cookie again,
   * or the user is logged out while the row is still valid.
   */
  describe("session renewal reaches the browser", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    async function withDaysLeft(
      days: number,
    ): Promise<{ cookie: string; tenantId: string; id: string }> {
      const token = generateSessionToken();
      const session = await createSession(
        token,
        await createUser({ tenantId: alpha.tenantId }),
        alpha.tenantId,
      );
      await run("UPDATE session SET expires_at = ? WHERE id = ?", [
        Math.floor((Date.now() + days * DAY_MS) / 1000),
        session.id,
      ]);
      return {
        cookie: `session=${token}`,
        tenantId: alpha.tenantId,
        id: session.id,
      };
    }

    async function storedExpiry(sessionId: string): Promise<number> {
      return (
        (await getOne("SELECT expires_at FROM session WHERE id = ?", [
          sessionId,
        ])) as { expires_at: number }
      ).expires_at;
    }

    it("sets the cookie again, about 30 days out, when it renews", async () => {
      const session = await withDaysLeft(10);

      const response = await get("/api/conversations", session);

      expect(response.status).toBe(200);
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${session.cookie};`);
      const expires = /Expires=([^;]+)/i.exec(setCookie)?.[1];
      expect(expires).toBeDefined();
      const cookieExpiry = Date.parse(expires!);
      expect(Math.abs(cookieExpiry - (Date.now() + 30 * DAY_MS))).toBeLessThan(
        60_000,
      );
      // The cookie and the row agree, to the second the cookie is rounded to.
      expect(
        Math.abs(cookieExpiry - (await storedExpiry(session.id)) * 1000),
      ).toBeLessThan(2_000);
    });

    it("sends no cookie while more than 15 days remain", async () => {
      const session = await withDaysLeft(20);
      const before = await storedExpiry(session.id);

      const response = await get("/api/conversations", session);

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await storedExpiry(session.id)).toBe(before);
    });

    it("sends no cookie on the request after a renewal", async () => {
      const session = await withDaysLeft(10);

      await get("/api/conversations", session);
      const again = await get("/api/conversations", session);

      expect(again.status).toBe(200);
      expect(again.headers.get("set-cookie")).toBeNull();
    });
  });

  /**
   * Changing a role or a membership is a tenant matter, so it works for a user
   * who belongs to other tenants too. VendeYa staff is the exception: their
   * powers live on the account, but a tenant admin could still lock them out.
   */
  describe("a tenant admin and VendeYa staff's membership", () => {
    async function roleOf(
      tenantId: string,
      userId: string,
    ): Promise<string | undefined> {
      return (await MembershipService.get(tenantId, userId))?.role;
    }

    function changeRole(auth: Session, userId: string, role: string) {
      return patch(`/api/admin/users/${userId}/role`, auth, { role });
    }

    function removeMembership(auth: Session, userId: string) {
      return app.request(`/api/admin/users/${userId}/membership`, {
        method: "DELETE",
        headers: { ...authHeaders(auth) },
      });
    }

    /** A promoted member account: an operator who kept a membership. */
    function operatorMember(): Promise<string> {
      return createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
        isPlatformOperator: true,
      });
    }

    it("refuses to change an operator's role and leaves the row alone", async () => {
      const operator = await operatorMember();

      const response = await changeRole(alphaAdmin, operator, "developer");

      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toContain(
        "VendeYa staff",
      );
      expect(await roleOf(alpha.tenantId, operator)).toBe("sales_agent");
    });

    it("refuses to remove an operator's membership and leaves the row alone", async () => {
      const operator = await operatorMember();

      const response = await removeMembership(alphaAdmin, operator);

      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toContain(
        "VendeYa staff",
      );
      expect(await roleOf(alpha.tenantId, operator)).toBe("sales_agent");
    });

    it("refuses an operator who also belongs to another tenant, all the same", async () => {
      const operator = await operatorMember();
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'sales_agent')`,
        [crypto.randomUUID(), beta.tenantId, operator],
      );

      expect((await changeRole(alphaAdmin, operator, "developer")).status).toBe(
        403,
      );
      expect((await removeMembership(alphaAdmin, operator)).status).toBe(403);
      expect(await roleOf(alpha.tenantId, operator)).toBe("sales_agent");
    });

    it("lets a platform operator change the role of another operator", async () => {
      const target = await operatorMember();
      const caller = await login(
        await createUser({ isPlatformOperator: true }),
        alpha.tenantId,
      );

      const response = await changeRole(caller, target, "developer");

      expect(response.status).toBe(200);
      expect(await roleOf(alpha.tenantId, target)).toBe("developer");
    });

    it("lets a platform operator remove an operator's membership", async () => {
      const target = await operatorMember();
      const caller = await login(
        await createUser({ isPlatformOperator: true }),
        alpha.tenantId,
      );

      const response = await removeMembership(caller, target);

      expect(response.status).toBe(200);
      expect(await MembershipService.get(alpha.tenantId, target)).toBeNull();
    });

    it("still lets a tenant admin change an ordinary member's role", async () => {
      const member = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });

      const response = await changeRole(alphaAdmin, member, "supervisor");

      expect(response.status).toBe(200);
      expect(await roleOf(alpha.tenantId, member)).toBe("supervisor");
    });

    it("still lets a tenant admin remove an ordinary member", async () => {
      const member = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });

      const response = await removeMembership(alphaAdmin, member);

      expect(response.status).toBe(200);
      expect(await MembershipService.get(alpha.tenantId, member)).toBeNull();
    });

    it("still lets a tenant admin change the role of a multi-tenant member", async () => {
      const member = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'sales_agent')`,
        [crypto.randomUUID(), beta.tenantId, member],
      );

      expect((await changeRole(alphaAdmin, member, "supervisor")).status).toBe(
        200,
      );
      expect(await roleOf(alpha.tenantId, member)).toBe("supervisor");
      expect(await roleOf(beta.tenantId, member)).toBe("sales_agent");
    });

    /**
     * `validateSessionToken` re-reads the membership on every request, so a
     * role change needs no session to be deleted. Deleting them only logged the
     * user out of every tenant they belong to.
     */
    describe("a role change and the user's session", () => {
      it("shows the new role on the next request with the same session", async () => {
        const member = await createUser({
          tenantId: alpha.tenantId,
          role: "sales_agent",
        });
        const session = await login(member, alpha.tenantId);

        expect((await get("/api/admin/users", session)).status).toBe(403);

        expect((await changeRole(alphaAdmin, member, "admin")).status).toBe(
          200,
        );
        expect((await get("/api/admin/users", session)).status).toBe(200);

        expect(
          (await changeRole(alphaAdmin, member, "sales_agent")).status,
        ).toBe(200);
        expect((await get("/api/admin/users", session)).status).toBe(403);
      });

      it("keeps the user logged in, in this tenant and in the others", async () => {
        const member = await createUser({
          tenantId: alpha.tenantId,
          role: "sales_agent",
        });
        await run(
          `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
           VALUES (?, ?, ?, 'sales_agent')`,
          [crypto.randomUUID(), beta.tenantId, member],
        );
        const inAlpha = await login(member, alpha.tenantId);
        const inBeta = await login(member, beta.tenantId);

        await changeRole(alphaAdmin, member, "supervisor");

        expect((await get("/api/conversations", inAlpha)).status).toBe(200);
        expect((await get("/api/conversations", inBeta)).status).toBe(200);
      });
    });
  });

  /**
   * A conversation is (tenant, channel account, phone number). The `:phone`
   * parameter alone is ambiguous when a contact writes to two of the tenant's
   * numbers, so the API must refuse to guess which thread is meant.
   */
  describe("a contact on two of the tenant's numbers", () => {
    let second: Awaited<ReturnType<typeof addChannelAccount>>;

    beforeEach(async () => {
      second = await addChannelAccount(alpha);
      await insertConversation(second.ref(SHARED_PHONE));
    });

    it("refuses to guess which thread is meant", async () => {
      const response = await get(
        `/api/conversations/${SHARED_PHONE}`,
        alphaAdmin,
      );

      expect(response.status).toBe(409);

      const body = (await response.json()) as {
        error: string;
        channels: Array<{ channelAccountId: string }>;
      };
      expect(body.error).toBe("Ambiguous conversation");
      expect(body.channels.map((ch) => ch.channelAccountId).sort()).toEqual(
        [alpha.channelAccountId, second.channelAccountId].sort(),
      );
    });

    it("opens the named thread when the channel account is given", async () => {
      const first = await getJson(
        `/api/conversations/${SHARED_PHONE}?channel=${alpha.channelAccountId}`,
        alphaAdmin,
      );
      const other = await getJson(
        `/api/conversations/${SHARED_PHONE}?channel=${second.channelAccountId}`,
        alphaAdmin,
      );

      expect(first.conversation.customer_name).toBe("Alpha Client");
      expect(first.conversation.channel_account_id).toBe(
        alpha.channelAccountId,
      );
      // A customer is one phone number in a business, so both threads name them.
      expect(other.conversation.customer_name).toBe("Alpha Client");
      expect(other.conversation.channel_account_id).toBe(
        second.channelAccountId,
      );
    });

    it("does not attach an order to a guessed thread", async () => {
      expect(
        await getJson<{ order: unknown }>(
          `/api/orders/by-conversation/${SHARED_PHONE}`,
          alphaAdmin,
        ),
      ).toEqual({ order: null });
    });

    /**
     * An order belongs to a customer, not a thread, so it needs no number to
     * be unambiguous. A number it names must be the business's own.
     */
    it("records the number an order names, and refuses another business's", async () => {
      const post = (channelAccountId: string) =>
        app.request("/api/orders", {
          method: "POST",
          headers: {
            ...authHeaders(alphaAdmin),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            customer: { name: "Alpha Client", phone: SHARED_PHONE },
            channel_account_id: channelAccountId,
            lines: [{ name: "Terma", quantity: 1, unit_price_cents: 10000 }],
            shipment: null,
          }),
        });

      const named = await post(second.channelAccountId);
      expect(named.status).toBe(201);
      const created = (await named.json()) as { channel_account_id: string };
      expect(created.channel_account_id).toBe(second.channelAccountId);

      expect((await post(beta.channelAccountId)).status).toBe(404);
    });

    it("a still-unambiguous contact needs no channel account", async () => {
      const onlyOnce = "51900000009";
      await insertConversation(alpha.ref(onlyOnce), { clientName: "Single" });

      const detail = await getJson(
        `/api/conversations/${onlyOnce}`,
        alphaAdmin,
      );
      expect(detail.conversation.customer_name).toBe("Single");
    });

    /**
     * The dashboard's own links have to name the thread, or they land on the
     * 409 above. The order records the channel account it came in on, so the
     * order page links with both values. The test renders the page with the
     * order the API returns and follows its link the way a click would.
     */
    it("the order page links to the thread the order belongs to", async () => {
      const order = await fileOrder(second.ref(SHARED_PHONE), {
        name: "Alpha Client, second number",
      });

      kitPage.params.tenantId = alpha.tenantId;
      const page = await renderComponent(ORDER_PAGE, {
        data: {
          order: await getJson(`/api/orders/${order.id}`, alphaAdmin),
          methods: [],
        },
      });
      const business = `/dashboard/${alpha.tenantId}`;
      const link = new RegExp(`href="(${business}/conversations/[^"]+)"`).exec(
        page,
      )?.[1];
      expect(link).toBeDefined();

      const response = await get(
        link!.replace(`${business}/conversations/`, "/api/conversations/"),
        alphaAdmin,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        conversation: { channel_account_id: string };
      };
      expect(body.conversation.channel_account_id).toBe(
        second.channelAccountId,
      );
    });
  });

  /**
   * The tenant's own status is re-read on every request, like membership. A
   * session pinned before the suspension must lose read and write access at
   * once instead of keeping it for the rest of its lifetime.
   */
  describe("suspending a tenant", () => {
    async function suspend(tenantId: string): Promise<void> {
      await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
        tenantId,
      ]);
    }

    it("cuts off a session that was already acting in it", async () => {
      expect((await get("/api/conversations", alphaAdmin)).status).toBe(200);

      await suspend(alpha.tenantId);

      const response = await get("/api/conversations", alphaAdmin);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: "Tenant not found",
      });
    });

    it("stops writes as well as reads", async () => {
      await suspend(alpha.tenantId);

      const response = await app.request("/api/orders", {
        method: "POST",
        headers: {
          ...authHeaders(alphaAdmin),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customer: { name: "Alpha Client", phone: SHARED_PHONE },
          lines: [{ name: "Terma", quantity: 1, unit_price_cents: 10000 }],
          shipment: null,
        }),
      });

      expect(response.status).toBe(404);
    });

    it("forgets it as the last business opened, and keeps the session", async () => {
      await suspend(alpha.tenantId);

      const { session, user } = await validateSessionToken(alphaAdmin.token);

      // Still logged in. /dashboard offers the picker rather than reopening it.
      expect(session).not.toBeNull();
      expect(user?.lastTenantId).toBeNull();
    });

    it("leaves the other tenant working", async () => {
      await suspend(alpha.tenantId);

      expect((await get("/api/conversations", betaAdmin)).status).toBe(200);
    });

    it("is closed to a platform operator too", async () => {
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        alpha.tenantId,
      );
      expect((await get("/api/conversations", operator)).status).toBe(200);

      await suspend(alpha.tenantId);

      expect((await get("/api/conversations", operator)).status).toBe(404);
    });
  });

  /**
   * A number registered before SECRETS_KEY was configured is 'pending' and has
   * no token, so it cannot send. Supplying a token through the admin API must
   * also activate the number. Otherwise it stays unusable until somebody
   * PATCHes the status separately.
   */
  describe("giving a pending number its credentials", () => {
    const TOKEN = "EAAG-admin-supplied-token";

    let pendingId: string;

    beforeEach(async () => {
      pendingId = (
        await ChannelAccountService.create({
          tenantId: alpha.tenantId,
          phoneNumberId: `pnid-${crypto.randomUUID().slice(0, 8)}`,
          label: "Segunda línea",
        })
      ).id;

      expect((await ChannelAccountService.getById(pendingId))?.status).toBe(
        "pending",
      );
    });

    it("activates the number the token arrives on", async () => {
      const response = await patch(
        `/api/admin/channels/${pendingId}`,
        alphaAdmin,
        { accessToken: TOKEN },
      );

      expect(response.status).toBe(200);
      expect(((await response.json()) as { status: string }).status).toBe(
        "active",
      );

      const account = (await ChannelAccountService.getById(pendingId))!;
      expect(account.status).toBe("active");
      expect(await ChannelAccountService.getAccessToken(account)).toBe(TOKEN);
    });

    it("still honours a status the request names", async () => {
      const response = await patch(
        `/api/admin/channels/${pendingId}`,
        alphaAdmin,
        { accessToken: TOKEN, status: "disabled" },
      );

      expect(((await response.json()) as { status: string }).status).toBe(
        "disabled",
      );
    });

    it("does not bring a disabled number back", async () => {
      await setChannelStatus(pendingId, "disabled");

      await patch(`/api/admin/channels/${pendingId}`, alphaAdmin, {
        accessToken: TOKEN,
      });

      expect((await ChannelAccountService.getById(pendingId))?.status).toBe(
        "disabled",
      );
    });

    it("does not touch another tenant's number", async () => {
      const response = await patch(
        `/api/admin/channels/${pendingId}`,
        betaAdmin,
        { accessToken: TOKEN },
      );

      expect(response.status).toBe(404);
      expect((await ChannelAccountService.getById(pendingId))?.status).toBe(
        "pending",
      );
    });

    /**
     * An account with no token must not become 'active'. Webhook intake accepts
     * inbound messages for any active account, and the outbound adapter refuses
     * to send without credentials. Such a number would consume customer
     * messages it can never answer. 'pending' is the state for exactly this.
     */
    describe("activating a number that cannot send", () => {
      it("refuses the transition when no token is stored", async () => {
        const response = await patch(
          `/api/admin/channels/${pendingId}`,
          alphaAdmin,
          { status: "active" },
        );

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toContain(
          "access token",
        );
      });

      it("leaves the account exactly as it was", async () => {
        await patch(`/api/admin/channels/${pendingId}`, alphaAdmin, {
          status: "active",
        });

        expect((await ChannelAccountService.getById(pendingId))?.status).toBe(
          "pending",
        );
      });

      it("does not half-apply the rest of the request", async () => {
        // The verify token is written before the status in the handler's own
        // order, so a refusal decided afterwards would leave it stored.
        const before = (await ChannelAccountService.getById(pendingId))!
          .verify_token_secret_id;

        await patch(`/api/admin/channels/${pendingId}`, alphaAdmin, {
          verifyToken: "verify-me",
          status: "active",
        });

        expect(
          (await ChannelAccountService.getById(pendingId))
            ?.verify_token_secret_id,
        ).toBe(before);
      });

      it("allows it when the token arrives in the same request", async () => {
        const response = await patch(
          `/api/admin/channels/${pendingId}`,
          alphaAdmin,
          { accessToken: TOKEN, status: "active" },
        );

        expect(response.status).toBe(200);
        expect(((await response.json()) as { status: string }).status).toBe(
          "active",
        );
      });

      it("allows it when one is already stored", async () => {
        // Disabled by a person, then turned back on: the credential is there,
        // and this is the ordinary re-enable.
        await ChannelAccountService.update(
          (await ChannelAccountService.getById(pendingId))!,
          { accessToken: TOKEN },
        );

        await setChannelStatus(pendingId, "disabled");

        const response = await patch(
          `/api/admin/channels/${pendingId}`,
          alphaAdmin,
          { status: "active" },
        );

        expect(response.status).toBe(200);
        expect((await ChannelAccountService.getById(pendingId))?.status).toBe(
          "active",
        );
      });

      it("still lets it be parked in a state it can honour", async () => {
        for (const status of ["pending", "disabled"] as const) {
          const response = await patch(
            `/api/admin/channels/${pendingId}`,
            alphaAdmin,
            { status },
          );

          expect(response.status).toBe(200);
          expect((await ChannelAccountService.getById(pendingId))?.status).toBe(
            status,
          );
        }
      });
    });
  });

  // Creation always stores the generated verify token encrypted, so without
  // SECRETS_KEY the POST refuses rather than dying inside `create`.
  it("refuses a channel create with no credentials when SECRETS_KEY is unset", async () => {
    const operator = await login(
      await createUser({
        tenantId: alpha.tenantId,
        isPlatformOperator: true,
      }),
      alpha.tenantId,
    );

    const phoneNumberId = `pnid-${crypto.randomUUID().slice(0, 8)}`;
    const previous = env.SECRETS_KEY;
    try {
      (env as unknown as Record<string, string>).SECRETS_KEY = "";

      const response = await post("/api/admin/channels", operator, {
        phoneNumberId,
      });

      expect(response.status).toBe(503);
      expect(
        await getOne(
          "SELECT COUNT(*) as count FROM channel_accounts WHERE phone_number_id = ?",
          [phoneNumberId],
        ),
      ).toEqual({ count: 0 });
    } finally {
      (env as unknown as Record<string, string>).SECRETS_KEY = previous;
    }
  });

  /**
   * A member with no pinned tenant is reported with a null role, not "admin".
   * A platform operator is admin in every scope. Login in routes/auth.ts and
   * `validateSessionToken` both derive the role from `sessionRole`. A member of
   * two tenants starts unpinned.
   */
  describe("an unpinned member is not reported as an admin", () => {
    let agentId: string;
    let agentSession: Awaited<ReturnType<typeof login>>;

    beforeEach(async () => {
      agentId = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'sales_agent')`,
        [crypto.randomUUID(), beta.tenantId, agentId],
      );

      // A member of two tenants starts unpinned, which is the case at issue.
      expect(await MembershipService.listForUser(agentId)).toHaveLength(2);
      expect(await defaultTenantForUser(agentId, false)).toBeNull();

      agentSession = await login(agentId, null);
    });

    it("reports no role at all while unpinned", async () => {
      expect(
        sessionRole({ isPlatformOperator: false, membershipRole: null }),
      ).toBeNull();

      const { user } = await validateSessionToken(agentSession.token);
      expect(user?.role).toBeNull();
      expect(user?.lastTenantId).toBeNull();
      expect(user?.isPlatformOperator).toBe(false);
    });

    it("reports the membership role on a business's page", async () => {
      const { user } = await validateSessionToken(
        agentSession.token,
        "browser",
        alpha.tenantId,
      );
      expect(user?.role).toBe("sales_agent");
    });

    it("still reports admin for a platform operator", async () => {
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        null,
      );
      const { user } = await validateSessionToken(operator.token);

      expect(user?.role).toBe("admin");
      expect(user?.isPlatformOperator).toBe(true);
    });

    it("grants no admin authority while unpinned", async () => {
      expect((await get("/api/admin/users", agentSession)).status).toBe(403);
      expect((await get("/api/conversations", agentSession)).status).toBe(403);
    });

    it("is still not an admin on a business's page", async () => {
      const inAlpha = { ...agentSession, tenantId: alpha.tenantId };

      expect((await get("/api/admin/users", inAlpha)).status).toBe(403);
      expect((await get("/api/conversations", inAlpha)).status).toBe(200);
    });
  });

  /**
   * A platform operator can also hold an ordinary membership in the tenant
   * they are pinned to. Their authority there is still the operator's, both in
   * what they are told and in what the role gates let through.
   */
  describe("a platform operator who is also a member of the pinned tenant", () => {
    let operatorSession: Awaited<ReturnType<typeof login>>;

    beforeEach(async () => {
      const operatorId = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
        isPlatformOperator: true,
      });
      operatorSession = await login(operatorId, alpha.tenantId);
    });

    it("is reported as an admin", async () => {
      const { user, scope } = await validateSessionToken(
        operatorSession.token,
        "browser",
        alpha.tenantId,
      );

      expect(scope?.tenantId).toBe(alpha.tenantId);
      expect(user?.role).toBe("admin");
    });

    it("holds admin authority in the role check", async () => {
      const { scope } = await validateSessionToken(
        operatorSession.token,
        "browser",
        alpha.tenantId,
      );
      if (!scope) throw new Error("The operator's session did not validate");

      expect(hasRole(scope, ["admin"])).toBe(true);
    });

    it("is let through an admin-gated route", async () => {
      expect((await get("/api/admin/users", operatorSession)).status).toBe(200);
    });
  });

  describe("a tenant admin and the platform's switches", () => {
    afterEach(async () => {
      await run("DELETE FROM system_settings");
    });

    it("does not let a tenant admin write platform-only switches", async () => {
      const response = await app.request("/api/admin/settings", {
        method: "POST",
        headers: {
          ...authHeaders(alphaAdmin),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ force_fnb_down: "true" }),
      });

      expect(await response.json()).toMatchObject({
        rejected: ["force_fnb_down"],
      });
      expect(await SystemSettings.get("force_fnb_down")).toBeNull();
    });
  });

  /**
   * A tenant admin sees only the platform values their dashboard draws. The
   * response must not include VendeYa's own deployment configuration, such as
   * `platform_ops_channel_account_id`, the channel account VendeYa's operations
   * alerts go out on.
   */
  describe("the platform values a tenant admin is shown", () => {
    const OPS_ACCOUNT_KEY = "platform_ops_channel_account_id";

    afterEach(async () => {
      await run("DELETE FROM system_settings");
    });

    it("does not include VendeYa's own deployment configuration", async () => {
      await SystemSettings.set(OPS_ACCOUNT_KEY, "ch-vendeya-internal");

      const settings = await getJson<Record<string, string>>(
        "/api/admin/settings",
        alphaAdmin,
      );

      expect(settings[OPS_ACCOUNT_KEY]).toBeUndefined();
      expect(JSON.stringify(settings)).not.toContain("ch-vendeya-internal");
      expect(settings._scope).toBe("tenant");
    });

    it("still includes the switches the dashboard renders, read-only", async () => {
      await SystemSettings.set("force_fnb_down", "true");
      await SystemSettings.set("force_gaso_down", "false");

      const settings = await getJson<Record<string, string>>(
        "/api/admin/settings",
        alphaAdmin,
      );

      expect(settings._platform_force_fnb_down).toBe("true");
      expect(settings._platform_force_gaso_down).toBe("false");
      // None under its own name: those are the fields a save posts back.
      expect(settings.force_fnb_down).toBeUndefined();
      expect(settings.force_gaso_down).toBeUndefined();
    });

    /**
     * The kill switches are reported under prefixed names. Under their raw names
     * the page would post them back on every save, and every save would answer
     * `rejected` for a write nobody attempted.
     */
    it("rejects nothing when the page saves back exactly what it loaded", async () => {
      await SystemSettings.set("force_fnb_down", "true");
      await SystemSettings.set("force_gaso_down", "false");
      await TenantSettings.set(alpha.tenantId, "business_name", "Gas Perú");

      const loaded = await getJson<Record<string, string>>(
        "/api/admin/settings",
        alphaAdmin,
      );

      const response = await post("/api/admin/settings", alphaAdmin, loaded);

      expect(await response.json()).toMatchObject({
        success: true,
        rejected: [],
        updates: { business_name: "Gas Perú" },
      });
      // And the platform's values are where they were.
      expect(await SystemSettings.get("force_fnb_down")).toBe("true");
    });

    /** The operator owns these and reads all of them on VendeYa's own page. */
    it("are all on the platform page, for a platform operator only", async () => {
      await SystemSettings.set(OPS_ACCOUNT_KEY, "ch-vendeya-internal");
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        null,
      );

      const settings = await getJson<Record<string, string>>(
        "/api/platform/settings",
        operator,
      );
      expect(settings[OPS_ACCOUNT_KEY]).toBe("ch-vendeya-internal");

      expect((await get("/api/platform/settings", alphaAdmin)).status).toBe(
        403,
      );
    });
  });

  /**
   * `tenant_settings` holds operator-owned settings and application-owned state
   * such as `last_agent_index`, the round-robin cursor of
   * domains/conversations/assignment.ts. A tenant admin must not write the
   * cursor, because the application reads it back as its own state.
   */
  describe("settings the application owns, not the operator", () => {
    const ROUND_ROBIN_KEY = "last_agent_index";

    function writeSettings(body: unknown) {
      return app.request("/api/admin/settings", {
        method: "POST",
        headers: {
          ...authHeaders(alphaAdmin),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    it("refuses a tenant admin writing the round-robin cursor", async () => {
      await TenantSettings.set(alpha.tenantId, ROUND_ROBIN_KEY, "2");

      const response = await writeSettings({ [ROUND_ROBIN_KEY]: "invalid" });

      expect(await response.json()).toMatchObject({
        rejected: [ROUND_ROBIN_KEY],
        updates: {},
      });
      expect(await TenantSettings.get(alpha.tenantId, ROUND_ROBIN_KEY)).toBe(
        "2",
      );
    });

    it("still takes the operator-owned keys in the same request", async () => {
      const response = await writeSettings({
        [ROUND_ROBIN_KEY]: "invalid",
        whatsapp_group_sales: "51900000000",
      });

      expect(await response.json()).toMatchObject({
        rejected: [ROUND_ROBIN_KEY],
        updates: { whatsapp_group_sales: "51900000000" },
      });
      expect(
        await TenantSettings.get(alpha.tenantId, ROUND_ROBIN_KEY),
      ).toBeNull();
    });

    /**
     * The dashboard posts back whatever the GET handed it, so a key it can see
     * is a key it resubmits on every save.
     */
    it("keeps it out of what the settings endpoint reports", async () => {
      await TenantSettings.set(alpha.tenantId, ROUND_ROBIN_KEY, "2");
      await TenantSettings.set(
        alpha.tenantId,
        "whatsapp_group_dev",
        "51900000001",
      );

      const settings = await getJson<Record<string, string>>(
        "/api/admin/settings",
        alphaAdmin,
      );

      expect(settings[ROUND_ROBIN_KEY]).toBeUndefined();
      expect(settings.whatsapp_group_dev).toBe("51900000001");
    });

    /**
     * Defence in depth for a row edited straight in the database. NaN survives
     * the modulo and is written back, so one bad read would otherwise poison
     * every assignment that followed.
     */
    it("assigns an agent even with a corrupt cursor already stored", async () => {
      await TenantSettings.set(alpha.tenantId, ROUND_ROBIN_KEY, "invalid");

      const agentId = await createUser({
        tenantId: alpha.tenantId,
        role: "sales_agent",
      });

      const assigned = await assignNextAgentHeld(alpha.ref(SHARED_PHONE));

      expect(assigned).toBe(agentId);
      expect(await TenantSettings.get(alpha.tenantId, ROUND_ROBIN_KEY)).toBe(
        "0",
      );
    });
  });

  /**
   * A request that names no business acts in none. A platform operator has no
   * cross-business view through the business routes; that lives under
   * /api/platform.
   */
  describe("a platform operator on no business's page", () => {
    const BETA_ONLY = "51900000002";
    let operator: Session;

    beforeEach(async () => {
      operator = await login(
        await createUser({ isPlatformOperator: true }),
        null,
      );
      await insertConversation(beta.ref(BETA_ONLY), {
        clientName: "Beta Only",
      });
    });

    async function conversationRow(phone: string, tenantId: string) {
      return (await getOne(
        `SELECT status, assigned_agent FROM conversations
           WHERE tenant_id = ? AND phone_number = ?`,
        [tenantId, phone],
      )) as {
        status: string;
        assigned_agent: string | null;
      };
    }

    function write(path: string, auth: Session, init: RequestInit = {}) {
      return app.request(`/api/conversations/${BETA_ONLY}${path}`, {
        method: "POST",
        headers: { ...authHeaders(auth), "Content-Type": "application/json" },
        ...init,
      });
    }

    it("is refused every write route", async () => {
      const responses = await Promise.all([
        write("/takeover", operator),
        write("/message", operator, {
          body: JSON.stringify({ content: "hola" }),
        }),
        write("/release", operator),
        write("/decline-assignment", operator),
      ]);

      expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403]);
      expect(await responses[0]!.json()).toMatchObject({
        error: "No active tenant",
      });
    });

    it("leaves the other tenant's conversation untouched", async () => {
      const before = await conversationRow(BETA_ONLY, beta.tenantId);

      await write("/takeover", operator);

      expect(await conversationRow(BETA_ONLY, beta.tenantId)).toEqual(before);
    });

    it("is refused reads as well", async () => {
      expect(
        (await get(`/api/conversations/${BETA_ONLY}`, operator)).status,
      ).toBe(403);
      expect((await get("/api/conversations", operator)).status).toBe(403);
    });

    it("writes on the page of the business it names", async () => {
      const inBeta = { ...operator, tenantId: beta.tenantId };

      expect((await write("/takeover", inBeta)).status).toBe(200);
      expect((await conversationRow(BETA_ONLY, beta.tenantId)).status).toBe(
        "human_takeover",
      );
    });

    it("refuses a member of two businesses who names neither", async () => {
      const inBoth = await createUser({ tenantId: alpha.tenantId });
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`,
        [crypto.randomUUID(), beta.tenantId, inBoth],
      );

      const unpinned = await login(inBoth, null);

      expect((await write("/takeover", unpinned)).status).toBe(403);
    });
  });

  /**
   * `writeTenantId` is the invariant behind both `requireTenantScope` and
   * `activeTenantId`. A route that reads the business without the middleware
   * in front of it is a bug, and this is what it costs: the request is
   * refused, not served unscoped.
   */
  describe("a route that forgets requireTenantScope", () => {
    function appWithUnguardedWrite() {
      const unguarded = new Hono();
      unguarded.onError(errorHandler);
      unguarded.use("/api/*", requireAuth);
      unguarded.post("/api/unguarded", (c) =>
        c.json({ tenantId: activeTenantId(c) }),
      );
      return unguarded;
    }

    function post(auth: Session) {
      return appWithUnguardedWrite().request("/api/unguarded", {
        method: "POST",
        headers: { ...authHeaders(auth) },
      });
    }

    it("refuses a caller that names no business instead of failing open", async () => {
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        null,
      );

      const response = await post(operator);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "No active tenant",
      });
    });

    it("still answers one that names its business", async () => {
      const response = await post(alphaAdmin);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tenantId: alpha.tenantId });
    });
  });

  describe("a request that names its business", () => {
    function getIn(path: string, auth: Session, tenantId: string) {
      return app.request(path, {
        headers: { ...authHeaders(auth), "X-Tenant-Id": tenantId },
      });
    }

    it("acts in the named business and makes it the last opened", async () => {
      const userId = await createUser({ tenantId: alpha.tenantId });
      await run(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`,
        [crypto.randomUUID(), beta.tenantId, userId],
      );
      const session = await login(userId, alpha.tenantId);

      const response = await getIn(
        `/api/conversations/${SHARED_PHONE}`,
        session,
        beta.tenantId,
      );
      expect(response.status).toBe(200);
      const detail = (await response.json()) as {
        conversation: { customer_name: string };
      };
      expect(detail.conversation.customer_name).toBe("Beta Client");

      const { user } = await validateSessionToken(session.token);
      expect(user?.lastTenantId).toBe(beta.tenantId);
    });

    it("refuses a business the caller does not belong to", async () => {
      const response = await getIn(
        "/api/conversations",
        alphaAdmin,
        beta.tenantId,
      );
      expect(response.status).toBe(404);

      const { user } = await validateSessionToken(alphaAdmin.token);
      expect(user?.lastTenantId).toBe(alpha.tenantId);
    });

    it("lets a platform operator name any open business", async () => {
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        null,
      );
      const response = await getIn(
        "/api/conversations",
        operator,
        beta.tenantId,
      );
      const rows = (await response.json()) as Array<{ tenant_id: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === beta.tenantId)).toBe(true);
    });

    it("refuses a suspended business, even to an operator", async () => {
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        null,
      );
      await run(`UPDATE tenants SET status = 'suspended' WHERE id = ?`, [
        beta.tenantId,
      ]);
      const response = await getIn(
        "/api/conversations",
        operator,
        beta.tenantId,
      );
      expect(response.status).toBe(404);
    });
  });

  /**
   * Logging in for somebody whose only business is suspended. Belonging to a
   * suspended tenant is still belonging, so login succeeds with no business to
   * open. That matches a session already held through the suspension, which
   * `validateSessionToken` keeps and forgets the business of.
   */
  describe("logging in", () => {
    const PASSWORD = "the-right-password";

    async function userWithPassword(tenantId?: string): Promise<string> {
      const userId = await createUser({ tenantId });
      await run("UPDATE users SET password_hash = ? WHERE id = ?", [
        await hashPassword(PASSWORD),
        userId,
      ]);
      return userId;
    }

    async function logIn(userId: string, password = PASSWORD) {
      const { email } = (await getOne("SELECT email FROM users WHERE id = ?", [
        userId,
      ])) as { email: string };

      return app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    }

    async function suspend(tenantId: string): Promise<void> {
      await run("UPDATE tenants SET status = 'suspended' WHERE id = ?", [
        tenantId,
      ]);
    }

    it("names a member's one open business as the one to open", async () => {
      const response = await logIn(await userWithPassword(alpha.tenantId));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        user: { lastTenantId: alpha.tenantId, role: "admin" },
      });
    });

    it("lets in a member whose only business is suspended, with none to open", async () => {
      const userId = await userWithPassword(alpha.tenantId);
      await suspend(alpha.tenantId);

      const response = await logIn(userId);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        user: { lastTenantId: null, role: null },
        // Nothing they can pick, which is what the dashboard then shows.
        tenants: [],
      });

      // A real session, in the same state an existing one is left in.
      const [cookie = ""] = (response.headers.get("set-cookie") ?? "").split(
        ";",
      );
      const me = await app.request("/api/auth/me", {
        headers: { Cookie: cookie },
      });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        user: { id: userId, lastTenantId: null },
      });

      // And no way to act in the suspended business through it.
      expect(
        (
          await app.request("/api/conversations", {
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(403);
    });

    it("still refuses their wrong password", async () => {
      const userId = await userWithPassword(alpha.tenantId);
      await suspend(alpha.tenantId);

      expect((await logIn(userId, "not-the-password")).status).toBe(401);
    });

    it("still refuses somebody who belongs to no business at all", async () => {
      expect((await logIn(await userWithPassword())).status).toBe(401);
    });
  });

  /**
   * The account is shaped like a migrated admin after `bun run account promote`:
   * it keeps its membership and is also platform staff. An upgraded
   * single-business deployment has no operator until one is promoted, so the
   * flag alone must be enough to create a tenant.
   */
  describe("creating the second tenant", () => {
    const name = "Second Business";

    afterEach(async () => {
      await run("DELETE FROM tenants WHERE name = ?", [name]);
    });

    it("is what the platform operator flag buys a migrated admin", async () => {
      const operator = await login(
        await createUser({
          tenantId: alpha.tenantId,
          isPlatformOperator: true,
        }),
        alpha.tenantId,
      );

      const response = await post("/api/tenants", operator, { name });

      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ name, status: "active" });
    });

    it("is closed to the same admin without it", async () => {
      const admin = await login(
        await createUser({ tenantId: alpha.tenantId }),
        alpha.tenantId,
      );

      const response = await post("/api/tenants", admin, { name });

      expect(response.status).toBe(403);
    });
  });

  /**
   * The dashboard's setup checklist reads this one endpoint, and the brief
   * hides the checklist once every step is done. Each flag must come from the
   * same rows the feature checks, so the test walks a bare tenant from all
   * pending to complete by writing the data each step reads.
   */
  describe("business setup status", () => {
    it("refuses a caller with no business active", async () => {
      const unpinnedOperator = await login(
        await createUser({ isPlatformOperator: true }),
        null,
      );
      expect(
        (await get("/api/admin/setup-status", unpinnedOperator)).status,
      ).toBe(403);
    });

    it("reports every step pending, then done as its data lands", async () => {
      const tenantId = await insertTenant("setup-status");
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        tenantId,
      );
      const status = () => getJson("/api/admin/setup-status", operator);

      expect(await status()).toEqual({
        openai_configured: false,
        has_catalog: false,
        has_stock: false,
        has_payment_methods: false,
        tried_simulator: false,
        whatsapp_configured: false,
        calidda_configured: false,
        complete: false,
      });

      await TenantSecrets.set(tenantId, "openai_api_key", "sk-test");
      expect((await status()).openai_configured).toBe(true);

      // The assistant offers only an active product with an active variant,
      // so a product with nothing to sell stays pending.
      const product = await ProductService.create({
        tenantId,
        name: "Cocina",
        category: "Cocinas",
      });
      expect((await status()).has_catalog).toBe(false);
      const variant = await VariantService.create(tenantId, product.id, {
        name: null,
        sku: "COCINA-1",
        price_cents: 100000,
        cost_cents: null,
        is_active: 1,
      });
      expect((await status()).has_catalog).toBe(true);

      // The assistant cannot take an order for a unit it cannot reserve, so a
      // catalog with every unit reserved still has no stock.
      const location = await StockService.defaultLocation(tenantId);
      const move = (kind: "receive" | "reserve") =>
        StockService.record({
          tenantId,
          variantId: variant.id,
          locationId: location!.id,
          kind,
          quantity: 1,
          createdBy: null,
        });
      await move("receive");
      await move("reserve");
      expect((await status()).has_stock).toBe(false);
      await move("receive");
      expect((await status()).has_stock).toBe(true);

      // An order can only be paid with an active method, so a paused one
      // stays pending.
      await PaymentMethodService.create(tenantId, {
        name: "Yape",
        is_active: 0,
      });
      expect((await status()).has_payment_methods).toBe(false);
      await PaymentMethodService.create(tenantId, { name: "Efectivo" });
      expect((await status()).has_payment_methods).toBe(true);

      await insertConversation(await simulatorRef(tenantId, "51900000001"));
      expect((await status()).tried_simulator).toBe(true);

      // A number must be able to receive (app secret) and answer (access
      // token) to count, so a row missing either stays pending.
      await ChannelAccountService.create({
        id: `ch-${crypto.randomUUID()}`,
        tenantId,
        phoneNumberId: `pnid-${crypto.randomUUID().slice(0, 8)}`,
        status: "active",
      });
      expect((await status()).whatsapp_configured).toBe(false);
      await ChannelAccountService.create({
        id: `ch-${crypto.randomUUID()}`,
        tenantId,
        phoneNumberId: `pnid-${crypto.randomUUID().slice(0, 8)}`,
        accessToken: "test-access-token",
        appSecret: "test-app-secret",
        status: "active",
      });
      expect((await status()).whatsapp_configured).toBe(true);

      // Cálidda and a team are optional: setup completes without either.
      const done = await status();
      expect(done.calidda_configured).toBe(false);
      expect(done.complete).toBe(true);

      await setCaliddaLogin(tenantId);
      expect((await status()).calidda_configured).toBe(true);
    });

    it("grants a membership named by email or user id", async () => {
      const operator = await login(
        await createUser({ isPlatformOperator: true }),
        null,
      );
      const memberId = await createUser({});
      const { email } = (await getOne<{ email: string }>(
        "SELECT email FROM users WHERE id = ?",
        [memberId],
      )) as { email: string };

      // Emails are matched as the account stores them: trimmed, any case.
      const byEmail = await post(
        `/api/tenants/${alpha.tenantId}/members`,
        operator,
        { email: ` ${email.toUpperCase()} `, role: "supervisor" },
      );
      expect(byEmail.status).toBe(201);
      expect(await MembershipService.get(alpha.tenantId, memberId)).toEqual(
        expect.objectContaining({ role: "supervisor" }),
      );

      const unknown = await post(
        `/api/tenants/${alpha.tenantId}/members`,
        operator,
        { email: `${crypto.randomUUID()}@test.invalid`, role: "admin" },
      );
      expect(unknown.status).toBe(404);

      const byId = await post(
        `/api/tenants/${beta.tenantId}/members`,
        operator,
        { userId: memberId, role: "sales_agent" },
      );
      expect(byId.status).toBe(201);
      expect(await MembershipService.get(beta.tenantId, memberId)).toEqual(
        expect.objectContaining({ role: "sales_agent" }),
      );
    });
  });
});
