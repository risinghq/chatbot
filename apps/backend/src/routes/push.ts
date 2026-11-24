import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { activeTenantId, requireTenantScope } from "../middleware/auth.ts";
import { logAction } from "../platform/audit/logger.ts";
import {
  deletePushSubscription,
  savePushSubscription,
} from "../domains/notifications/push.ts";

/**
 * Web Push subscriptions, scoped to the caller's membership in the business the
 * request names. A subscription is a secret the browser holds: only the owner
 * writes or removes it.
 */
const push = new Hono();

push.use("/*", requireTenantScope);

push.get("/vapid-public-key", (c) =>
  c.json({ publicKey: env.VAPID_PUBLIC_KEY || null }),
);

push.put("/subscription", async (c) => {
  const body = await c.req.json<{ endpoint?: unknown; keys?: unknown }>();
  const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined;

  if (
    typeof body.endpoint !== "string" ||
    !body.endpoint.startsWith("https://") ||
    typeof keys?.p256dh !== "string" ||
    typeof keys?.auth !== "string"
  ) {
    return c.json({ error: "Invalid push subscription" }, 400);
  }

  const tenantId = activeTenantId(c);
  const userId = c.get("user").id;
  await savePushSubscription(tenantId, userId, {
    endpoint: body.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  });
  await logAction(
    { userId, tenantId },
    "save_push_subscription",
    "push_subscription",
    null,
    { endpoint: body.endpoint },
  );
  return c.json({ ok: true }, 201);
});

push.delete("/subscription", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    endpoint?: unknown;
  };
  if (typeof body.endpoint !== "string") {
    return c.json({ error: "Invalid push subscription" }, 400);
  }
  const tenantId = activeTenantId(c);
  const userId = c.get("user").id;
  await deletePushSubscription(tenantId, userId, body.endpoint);
  await logAction(
    { userId, tenantId },
    "delete_push_subscription",
    "push_subscription",
    null,
    { endpoint: body.endpoint },
  );
  return c.json({ ok: true });
});

export default push;
