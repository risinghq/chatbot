/**
 * What a business sells is unanswered until its admin picks it on the welcome
 * step. The tenant list carries it, so the dashboard can shape the catalog
 * forms, and only an admin of the business changes it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import adminRoutes from "../src/routes/admin.ts";
import tenantRoutes from "../src/routes/tenants.ts";
import { getOne } from "./helpers/db.ts";
import { createMember, createTenantFixture } from "./helpers/tenancy.ts";

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api/tenants", tenantRoutes);
app.use("/api/admin/*", requireRole("admin"));
app.route("/api/admin", adminRoutes);
app.onError(errorHandler);

type Caller = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<Response>;

async function callerAs(
  tenantId: string,
  role: "admin" | "sales_agent",
): Promise<Caller> {
  const { userId } = await createMember({ tenantId }, role);
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);
  return async (method, path, body) =>
    await app.request(path, {
      method,
      headers: {
        Cookie: `session=${token}`,
        "X-Tenant-Id": tenantId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

describe("a business's kind", () => {
  let tenantId: string;
  let admin: Caller;

  beforeEach(async () => {
    ({ tenantId } = await createTenantFixture("business-kind"));
    admin = await callerAs(tenantId, "admin");
  });

  async function listedKind(caller: Caller): Promise<unknown> {
    const { tenants } = (await (
      await caller("GET", "/api/tenants")
    ).json()) as {
      tenants: Array<{ id: string; business_kind: unknown }>;
    };
    return tenants.find((t) => t.id === tenantId)?.business_kind;
  }

  it("is unanswered for a new business", async () => {
    expect(await listedKind(admin)).toBeNull();
  });

  it("is set by the business's admin and listed with the business", async () => {
    const response = await admin("PATCH", "/api/admin/business", {
      business_kind: "clothing",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await listedKind(admin)).toBe("clothing");
    expect(
      await getOne(
        "SELECT action FROM audit_log WHERE tenant_id = ? AND action = 'update_business'",
        [tenantId],
      ),
    ).toEqual({ action: "update_business" });
  });

  it("refuses a kind it does not know", async () => {
    const response = await admin("PATCH", "/api/admin/business", {
      business_kind: "spaceships",
    });

    expect(response.status).toBe(400);
    expect(await listedKind(admin)).toBeNull();
  });

  it("cannot be changed by a sales agent", async () => {
    const agent = await callerAs(tenantId, "sales_agent");

    const response = await agent("PATCH", "/api/admin/business", {
      business_kind: "food",
    });

    expect(response.status).toBe(403);
    expect(await listedKind(admin)).toBeNull();
  });
});
