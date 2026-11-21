/**
 * Each tenant checks credit with its own Cálidda login: the login lives in
 * `tenant_settings` and `tenant_secrets`, never in the Worker's environment,
 * and the password never reaches a dashboard response.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { FNBProvider } from "../src/domains/eligibility/providers/fnb-provider.ts";
import { CheckEligibilityHandler } from "../src/domains/eligibility/handlers/check-eligibility-handler.ts";
import { PowerBIProvider } from "../src/domains/eligibility/providers/powerbi-provider.ts";
import { ProviderError } from "../src/domains/eligibility/providers/provider.ts";
import { isErr } from "../src/shared/result/index.ts";
import { getOne } from "../src/db/index.ts";
import { fakeJwt } from "./helpers/jwt.ts";
import {
  createMember,
  createTenantFixture,
  insertUser,
  setCaliddaLogin,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import adminSystemRoutes from "../src/routes/admin/system.ts";
import providerRoutes from "../src/routes/providers.ts";
import { markBlocked } from "../src/adapters/providers/health.ts";

const FAKE_TOKEN = fakeJwt({ commercialAllyId: "123" });
const DNI = "12345678";

function creditResponse(credit: string, name: string) {
  return new Response(
    JSON.stringify({
      valid: true,
      data: { lineaCredito: credit, nombre: name },
    }),
  );
}

/** Serves the FNB endpoints and records the login body each tenant sent. */
function fakeCalidda(logins: string[]) {
  return vi.fn(async (input: any, init?: any) => {
    const url = input.toString();
    if (url.includes("autenticar")) {
      logins.push(JSON.parse(init.body).usuario);
      return new Response(
        JSON.stringify({ valid: true, data: { authToken: FAKE_TOKEN } }),
      );
    }
    if (url.includes("lineaCredito")) return creditResponse("1500.00", "Ana");
    if (url.includes("querydata"))
      return new Response("Error", { status: 500 });
    return new Response("Not Found", { status: 404 });
  }) as any;
}

describe("a tenant's Cálidda login", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is the login that tenant's check authenticates with", async () => {
    const alpha = await createTenantFixture("alpha");
    const beta = await createTenantFixture("beta");
    await setCaliddaLogin(alpha.tenantId, { username: "alpha-user" });
    await setCaliddaLogin(beta.tenantId, { username: "beta-user" });

    const logins: string[] = [];
    globalThis.fetch = fakeCalidda(logins);

    const provider = new FNBProvider();
    const phone = "51999999999";

    const alphaResult = await provider.checkEligibility(DNI, alpha.ref(phone));
    const betaResult = await provider.checkEligibility(DNI, beta.ref(phone));

    expect(alphaResult.ok && alphaResult.value.eligible).toBe(true);
    expect(betaResult.ok && betaResult.value.eligible).toBe(true);
    expect(logins).toEqual(["alpha-user", "beta-user"]);
  });

  it("takes the unavailable path when the tenant has no login", async () => {
    const tenant = await createTenantFixture("no-login");
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const result = await new FNBProvider().checkEligibility(
      DNI,
      tenant.ref("51999999999"),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(ProviderError);
      expect(result.error.reason).toBe("unavailable");
    }
    // Nothing was asked of Cálidda.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves a check with no credentials at all in system outage", async () => {
    const tenant = await createTenantFixture("nothing-set");
    globalThis.fetch = vi.fn() as any;

    const handler = new CheckEligibilityHandler(
      new FNBProvider(),
      new PowerBIProvider(),
    );
    const result = await handler.execute(DNI, tenant.ref("51999999999"));

    expect(result).toEqual({ ok: true, value: { status: "system_outage" } });
  });
});

describe("the password through the settings API", () => {
  let app: Hono;
  let tenant: TenantFixture;
  let cookie: string;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    app = new Hono();
    app.use("/api/*", requireAuth);
    app.use("/api/admin/*", requireRole("admin"));
    app.route("/api/admin", adminSystemRoutes);
    app.onError(errorHandler);

    tenant = await createTenantFixture("secrets");
    const admin = await createMember(tenant, "admin");
    const token = generateSessionToken();
    await createSession(token, admin.userId, tenant.tenantId);
    cookie = `session=${token}`;
  });

  function postSettings(body: unknown) {
    return app.request("/api/admin/settings", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("re-authenticates with the new login after a save", async () => {
    await setCaliddaLogin(tenant.tenantId, { username: "alpha-user" });
    const logins: string[] = [];
    globalThis.fetch = fakeCalidda(logins);
    const provider = new FNBProvider();
    const ref = tenant.ref("51999999999");

    await provider.checkEligibility(DNI, ref);
    await postSettings({ calidda_username: "alpha-user-2" });
    await provider.checkEligibility(DNI, ref);

    // The second check logged in again: the save dropped the cached session.
    expect(logins).toEqual(["alpha-user", "alpha-user-2"]);
  });

  it("is stored encrypted and never returned", async () => {
    const password = "s3cr3t-c4l1dd4";

    const postResponse = await postSettings({
      calidda_base_url: "https://appweb.calidda.com.pe",
      calidda_username: "tenant-user",
      calidda_password: password,
    });
    expect(postResponse.status).toBe(200);
    expect(await postResponse.text()).not.toContain(password);

    const getResponse = await app.request("/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    const settings = await getResponse.json<Record<string, string>>();

    expect(JSON.stringify(settings)).not.toContain(password);
    expect(settings.calidda_password).toBeUndefined();
    expect(settings._has_calidda_password).toBe("true");
    expect(settings.calidda_username).toBe("tenant-user");

    // The row in D1 holds ciphertext, and no plaintext column at all.
    const stored = await getOne<{ value: string }>(
      "SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = 'calidda_password'",
      [tenant.tenantId],
    );
    expect(stored).toBeUndefined();
    const secret = await getOne<{ ciphertext: string }>(
      "SELECT ciphertext FROM tenant_secrets WHERE tenant_id = ? AND key = 'calidda_password'",
      [tenant.tenantId],
    );
    expect(secret?.ciphertext).toBeTruthy();
    expect(secret?.ciphertext).not.toContain(password);
  });
});

/**
 * GET /api/providers/:dni runs for no tenant of its own, so it names the
 * tenant whose Cálidda login FNB should use.
 */
describe("the operator's DNI lookup", () => {
  let app: Hono;
  let cookie: string;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    app = new Hono();
    app.use("/api/*", requireAuth);
    app.route("/api/providers", providerRoutes);
    app.onError(errorHandler);

    const userId = await insertUser({ name: "Op", isPlatformOperator: true });
    const token = generateSessionToken();
    await createSession(token, userId, null);
    cookie = `session=${token}`;
  });

  function lookup(path: string) {
    return app.request(path, { headers: { Cookie: cookie } });
  }

  it("answers FNB through the tenant named in the query", async () => {
    const tenant = await createTenantFixture("lookup");
    await setCaliddaLogin(tenant.tenantId, { username: "lookup-user" });

    const logins: string[] = [];
    globalThis.fetch = fakeCalidda(logins);

    const response = await lookup(
      `/api/providers/${DNI}?tenant=${tenant.tenantId}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(logins).toEqual(["lookup-user"]);
    expect(JSON.stringify(body)).not.toContain("FNB requires a tenant");
  });

  it("says FNB needs a tenant when none is named", async () => {
    globalThis.fetch = fakeCalidda([]);

    const response = await lookup(`/api/providers/${DNI}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain("FNB requires a tenant");
  });

  it("drops FNB from providersChecked when the named tenant is blocked", async () => {
    const tenant = await createTenantFixture("blocked-lookup");
    await setCaliddaLogin(tenant.tenantId);
    await markBlocked("fnb", "bloqueado", tenant.tenantId);

    globalThis.fetch = fakeCalidda([]);
    const response = await lookup(
      `/api/providers/${DNI}?tenant=${tenant.tenantId}`,
    );
    const body = (await response.json()) as { providersChecked: string[] };

    expect(response.status).toBe(200);
    expect(body.providersChecked).not.toContain("fnb");
    expect(body.providersChecked).toContain("gaso");
  });
});
