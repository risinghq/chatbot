/**
 * Each business brings its own OpenAI key, stored encrypted in tenant_secrets
 * and entered on the dashboard. The turn's model calls go out with that key,
 * and a tenant admin writes only its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { createCompletion } from "@vendeya/intelligence";
import { TenantSecrets } from "../src/domains/settings/tenant-secrets.ts";
import {
  hasOpenAiApiKey,
  openAiApiKey,
} from "../src/domains/settings/openai.ts";
import {
  createMember,
  createTenantFixture,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import { getOne } from "../src/db/index.ts";
import adminSystemRoutes from "../src/routes/admin/system.ts";

const SECRET = "sk-tenant-secret-key";

/** An OpenAI API that records the key each request authenticates with. */
function fakeOpenAI(keys: (string | null)[]) {
  return vi.fn(async (input: any, init?: any) => {
    keys.push(
      new Request(input, init).headers.get("authorization")?.slice(7) ?? null,
    );
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hola" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as any;
}

describe("the tenant's OpenAI key", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is read back decrypted once stored through TenantSecrets", async () => {
    const tenant = await createTenantFixture("openai");

    expect(await openAiApiKey(tenant.tenantId)).toBeNull();
    expect(await hasOpenAiApiKey(tenant.tenantId)).toBe(false);

    await TenantSecrets.set(tenant.tenantId, "openai_api_key", SECRET);

    expect(await openAiApiKey(tenant.tenantId)).toBe(SECRET);
    expect(await hasOpenAiApiKey(tenant.tenantId)).toBe(true);
  });

  // A key stored under another SECRETS_KEY is present but unreadable. The
  // health flag must agree with the provider: the tenant has no usable key.
  it("reports the key missing when SECRETS_KEY cannot read it", async () => {
    const tenant = await createTenantFixture("openai-rotated");
    await TenantSecrets.set(tenant.tenantId, "openai_api_key", SECRET);

    const previous = env.SECRETS_KEY;
    try {
      (env as unknown as Record<string, string>).SECRETS_KEY = "1".repeat(64);

      expect(await openAiApiKey(tenant.tenantId)).toBeNull();
      expect(await hasOpenAiApiKey(tenant.tenantId)).toBe(false);
    } finally {
      (env as unknown as Record<string, string>).SECRETS_KEY = previous;
    }
  });

  it("authenticates the turn's model calls with the tenant's key", async () => {
    const tenant = await createTenantFixture("openai-call");
    await TenantSecrets.set(tenant.tenantId, "openai_api_key", SECRET);

    const keys: (string | null)[] = [];
    globalThis.fetch = fakeOpenAI(keys);

    const complete = createCompletion((await openAiApiKey(tenant.tenantId))!);
    const reply = await complete({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      allowTools: false,
    });
    expect(reply.content).toBe("Hola");

    expect(keys).toEqual([SECRET]);
  });
});

describe("the key through the settings API", () => {
  let app: Hono;
  let tenant: TenantFixture;
  let other: TenantFixture;
  let cookie: string;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(async () => {
    // OpenAI's key check: it knows SECRET and refuses anything else.
    globalThis.fetch = (async (input: RequestInfo, init?: RequestInit) => {
      const key = new Request(input, init).headers.get("authorization");
      return new Response("{}", {
        status: key === `Bearer ${SECRET}` ? 200 : 401,
      });
    }) as typeof fetch;

    app = new Hono();
    app.use("/api/*", requireAuth);
    app.use("/api/admin/*", requireRole("admin"));
    app.route("/api/admin", adminSystemRoutes);
    app.onError(errorHandler);

    tenant = await createTenantFixture("openai-settings");
    other = await createTenantFixture("openai-other");
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

  it("stores the key encrypted, reports only that it is set", async () => {
    const postResponse = await postSettings({ openai_api_key: SECRET });
    expect(postResponse.status).toBe(200);
    expect(await postResponse.text()).not.toContain(SECRET);

    const getResponse = await app.request("/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    const settings = await getResponse.json<Record<string, string>>();

    expect(settings._has_openai_api_key).toBe("true");
    expect(JSON.stringify(settings)).not.toContain(SECRET);
    expect(await openAiApiKey(tenant.tenantId)).toBe(SECRET);
  });

  it("refuses a key OpenAI rejects and saves nothing from that request", async () => {
    const response = await postSettings({
      openai_api_key: "sk-revoked",
      bot_name: "Ana",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      reason: "invalid_openai_key",
    });
    expect(await openAiApiKey(tenant.tenantId)).toBeNull();
    expect(
      await getOne(
        "SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = 'bot_name'",
        [tenant.tenantId],
      ),
    ).toBeUndefined();
  });

  it("stores the key when OpenAI cannot be reached", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;

    expect(
      (await postSettings({ openai_api_key: "sk-unchecked" })).status,
    ).toBe(200);
    expect(await openAiApiKey(tenant.tenantId)).toBe("sk-unchecked");
  });

  it("lands in the caller's tenant and nowhere else", async () => {
    await postSettings({ openai_api_key: SECRET });

    expect(await openAiApiKey(tenant.tenantId)).toBe(SECRET);
    expect(await openAiApiKey(other.tenantId)).toBeNull();
    expect(
      await getOne<{ c: number }>(
        "SELECT COUNT(*) AS c FROM tenant_secrets WHERE key = 'openai_api_key'",
      ),
    ).toEqual({ c: 1 });
  });

  it("cannot be set at platform scope: it is a tenant secret", async () => {
    const operator = await createMember(other, "admin");
    const token = generateSessionToken();
    // A session pinned to no tenant writes platform settings, and the route
    // refuses tenant-secret keys there.
    await createSession(token, operator.userId, null);

    const response = await app.request("/api/admin/settings", {
      method: "POST",
      headers: {
        Cookie: `session=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ openai_api_key: SECRET }),
    });

    expect(response.status).not.toBe(200);
    expect(await openAiApiKey(other.tenantId)).toBeNull();
    expect(await openAiApiKey(tenant.tenantId)).toBeNull();
  });
});
