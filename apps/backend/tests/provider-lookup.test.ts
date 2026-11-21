/**
 * GET /api/providers/:dni returns one person's credit standing and spends the
 * providers' quota, so it answers VendeYa's own staff and nobody else.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  createMember,
  createTenantFixture,
  insertUser,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import { eligibilityHandler } from "../src/domains/eligibility/index.ts";
import { Ok } from "../src/shared/result/index.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import providerRoutes from "../src/routes/providers.ts";

const DNI = "12345678";
const ELIGIBILITY = { eligible: true, marker: "stubbed-provider-result" };

/** Mounted the way index.ts mounts it: behind the global session check. */
function buildApp() {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.route("/api/providers", providerRoutes);
  app.onError(errorHandler);
  return app;
}

async function login(
  userId: string,
  activeTenantId: string | null,
): Promise<string> {
  const token = generateSessionToken();
  await createSession(token, userId, activeTenantId);
  return `session=${token}`;
}

async function createPlatformOperator(): Promise<string> {
  return insertUser({ name: "Operator", isPlatformOperator: true });
}

describe("provider lookup", () => {
  let app: ReturnType<typeof buildApp>;
  let tenant: TenantFixture;
  let execute: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    app = buildApp();
    tenant = await createTenantFixture("provider-lookup");
    execute = vi
      .spyOn(eligibilityHandler, "execute")
      .mockResolvedValue(Ok(ELIGIBILITY) as never);
  });

  afterEach(async () => {
    execute.mockRestore();
  });

  function lookup(cookie: string | null, dni = DNI) {
    return app.request(`/api/providers/${dni}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
  }

  it("answers a platform operator with the provider result", async () => {
    const response = await lookup(
      await login(await createPlatformOperator(), null),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.dni).toBe(DNI);
    expect(body.result).toEqual(ELIGIBILITY);
    expect(Array.isArray(body.providersChecked)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the 400 for a DNI that is not 8 digits", async () => {
    const response = await lookup(
      await login(await createPlatformOperator(), null),
      "123",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "DNI debe tener 8 dígitos",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a tenant admin with 403 and asks no provider", async () => {
    const admin = await createMember(tenant, "admin");

    const response = await lookup(await login(admin.userId, tenant.tenantId));

    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a sales agent with 403 and asks no provider", async () => {
    const agent = await createMember(tenant, "sales_agent");

    const response = await lookup(await login(agent.userId, tenant.tenantId));

    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a caller with no session with 401 and asks no provider", async () => {
    const response = await lookup(null);

    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});
