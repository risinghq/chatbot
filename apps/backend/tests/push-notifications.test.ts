/**
 * Web Push notifications. A user opts in per business on Cuenta; the
 * subscription rides the same events and rules as the WhatsApp alerts, and a
 * push the service reports gone (404/410) deletes its row.
 */

import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

import { getOne, run } from "./helpers/db.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import { dispatchNotifications } from "../src/domains/notifications/dispatcher.ts";
import { evaluateNotifications } from "../src/domains/notifications/evaluator.ts";
import { notificationRules } from "../src/domains/notifications/config.ts";
import { base64Url } from "../src/adapters/push/index.ts";
import pushRoutes from "../src/routes/push.ts";
import type { DomainEvent } from "@vendeya/types";

const CUSTOMER = "51987654321";
const ENDPOINT = "https://push.example.test/sub/abc123";

let p256dh = "";
const SUBSCRIPTION = {
  endpoint: ENDPOINT,
  keys: { p256dh: "", auth: "tBHItJI5svbpez7KI4CCXg" },
};

/** The subscription's key must be a real P-256 point: the sender derives from it. */
async function setSubscriptionKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  p256dh = base64Url(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  SUBSCRIPTION.keys.p256dh = p256dh;
}

type Send = { url: string; headers: Record<string, string>; body: unknown };

function buildApp() {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.route("/api/push", pushRoutes);
  app.onError(errorHandler);
  return app;
}

/** A real P-256 pair: the sender signs its VAPID token with it. */
async function setVapidKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  env.VAPID_PUBLIC_KEY = base64Url(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  (env as { VAPID_PRIVATE_KEY?: string }).VAPID_PRIVATE_KEY = base64Url(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  env.VAPID_SUBJECT = "mailto:ops@vendeya.test";
}

describe("push subscriptions", () => {
  const app = buildApp();
  let tenantId: string;
  let userId: string;
  let cookie: string;

  beforeEach(async () => {
    tenantId = (await createTenantFixture("Push")).tenantId;
    userId = (await createMember({ tenantId }, "admin")).userId;
    const token = generateSessionToken();
    await createSession(token, userId, tenantId);
    cookie = `session=${token}`;
  });

  function send(
    method: string,
    path: string,
    body?: unknown,
    tenant = tenantId,
  ) {
    return app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Tenant-Id": tenant,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  it("answers the VAPID public key the browser subscribes with", async () => {
    await setVapidKeys();

    const res = await send("GET", "/api/push/vapid-public-key");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  it("saves a subscription for the member in the business, and deletes it", async () => {
    const res = await send("PUT", "/api/push/subscription", SUBSCRIPTION);
    expect(res.status).toBe(201);

    const row = (await getOne(
      "SELECT tenant_id, user_id, endpoint FROM push_subscriptions WHERE endpoint = ?",
      [ENDPOINT],
    )) as { tenant_id: string; user_id: string };
    expect(row.tenant_id).toBe(tenantId);

    const del = await send("DELETE", "/api/push/subscription", {
      endpoint: ENDPOINT,
    });
    expect(del.status).toBe(200);
    expect(
      await getOne("SELECT id FROM push_subscriptions WHERE endpoint = ?", [
        ENDPOINT,
      ]),
    ).toBeUndefined();
  });

  it("keeps a row per business for the same endpoint and user", async () => {
    const other = (await createTenantFixture("Push other")).tenantId;
    await run(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role)
       VALUES (?, ?, ?, 'admin')`,
      [crypto.randomUUID(), other, userId],
    );

    expect(
      (await send("PUT", "/api/push/subscription", SUBSCRIPTION)).status,
    ).toBe(201);
    expect(
      (await send("PUT", "/api/push/subscription", SUBSCRIPTION, other)).status,
    ).toBe(201);

    expect(
      await getOne(
        "SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?",
        [ENDPOINT],
      ),
    ).toEqual({ n: 2 });

    await send("DELETE", "/api/push/subscription", { endpoint: ENDPOINT });
    const left = (await getOne(
      "SELECT tenant_id FROM push_subscriptions WHERE endpoint = ?",
      [ENDPOINT],
    )) as { tenant_id: string };
    expect(left.tenant_id).toBe(other);
  });
});

describe("the push adapter", () => {
  let tenant: TenantFixture;
  let userId: string;
  let sends: Send[];
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tenant = await createTenantFixture("Push");
    userId = (await createMember({ tenantId: tenant.tenantId }, "admin"))
      .userId;
    await setVapidKeys();
    await setSubscriptionKey();

    sends = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      sends.push({
        url: input.toString(),
        headers: init?.headers,
        body: init?.body,
      });
      return new Response("", { status: 201 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function subscribe() {
    await run(
      `INSERT INTO push_subscriptions (id, tenant_id, user_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        tenant.tenantId,
        userId,
        ENDPOINT,
        p256dh,
        SUBSCRIPTION.keys.auth,
      ],
    );
  }

  /** The event an escalation raises, the same one the WhatsApp alert rides. */
  function escalation(): DomainEvent {
    return {
      type: "escalation_triggered",
      traceId: `trace-${crypto.randomUUID()}`,
      timestamp: Date.now(),
      tenantId: tenant.tenantId,
      channelAccountId: tenant.channelAccountId,
      payload: { phoneNumber: CUSTOMER, reason: "asked_for_a_person" },
    } as DomainEvent;
  }

  it("pushes to the assigned agent on the event that already notifies", async () => {
    await insertConversation(tenant.ref(CUSTOMER), {
      assignedAgent: userId,
      clientName: "Ana",
    });
    await subscribe();

    const event = escalation();
    await dispatchNotifications(
      evaluateNotifications(event, notificationRules),
      event,
    );

    const trace = (await getOne(
      "SELECT status, reason FROM notification_traces WHERE rule_id = 'escalation_push'",
      [],
    )) as { status: string; reason: string | null };
    expect(trace.reason).toBeNull();
    const push = sends.find((s) => s.url === ENDPOINT);
    expect(push).toBeDefined();
    expect(push!.headers["Authorization"]).toContain("vapid t=");
    expect(push!.headers["Authorization"]).toContain(
      `k=${env.VAPID_PUBLIC_KEY}`,
    );
    expect(push!.headers["Content-Encoding"]).toBe("aes128gcm");
    expect((push!.body as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  it("removes the subscription when the push service answers 410", async () => {
    await insertConversation(tenant.ref(CUSTOMER), { assignedAgent: userId });
    await subscribe();

    globalThis.fetch = (async () =>
      new Response("", { status: 410 })) as typeof fetch;

    const event = escalation();
    await dispatchNotifications(
      evaluateNotifications(event, notificationRules),
      event,
    );

    expect(
      await getOne("SELECT id FROM push_subscriptions WHERE endpoint = ?", [
        ENDPOINT,
      ]),
    ).toBeUndefined();
  });

  it("skips the push trace instead of failing when nobody subscribed", async () => {
    await insertConversation(tenant.ref(CUSTOMER), { assignedAgent: userId });

    const event = escalation();
    await dispatchNotifications(
      evaluateNotifications(event, notificationRules),
      event,
    );

    const trace = (await getOne(
      "SELECT status, reason FROM notification_traces WHERE rule_id = 'escalation_push'",
      [],
    )) as { status: string; reason: string | null };
    expect(trace).toEqual({ status: "skipped", reason: "no_recipient" });
    expect(sends).toHaveLength(0);
  });
});
