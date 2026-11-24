import { Hono } from "hono";
import { publicOrigin } from "../../config.ts";
import {
  TaypiApi,
  TaypiError,
  clearTaypiKeys,
  parseTaypiKeys,
  saveTaypiKeys,
  taypiEnvironment,
  taypiKeys,
} from "../../domains/payments/taypi.ts";
import { jsonObject } from "../../lib/http.ts";
import { activeTenantId, requireTenantScope } from "../../middleware/auth.ts";
import { logAction } from "../../platform/audit/logger.ts";

const taypi = new Hono();

taypi.use("/*", requireTenantScope);

/** Where TAYPI posts this business's payment events. */
function webhookUrl(tenantId: string): string {
  return `${publicOrigin()}/api/webhook/taypi/${tenantId}`;
}

/** Whether TAYPI is connected, and what to paste into TAYPI's panel. */
taypi.get("/", async (c) => {
  const tenantId = activeTenantId(c);
  const keys = await taypiKeys(tenantId);
  return c.json({
    connected: keys !== null,
    environment: keys ? taypiEnvironment(keys.publicKey) : null,
    webhook_url: webhookUrl(tenantId),
    domain: publicOrigin(),
  });
});

/**
 * Stores the three keys once TAYPI accepts them. Only a refusal (401, 403)
 * stops the save: an outage must not keep a business from connecting.
 */
taypi.put("/", async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const keys = parseTaypiKeys(body);
  if (typeof keys === "string") return c.json({ error: keys }, 400);

  let merchant: { business_name: string; webhook_url: string | null } | null =
    null;
  try {
    merchant = await TaypiApi.merchant(keys);
  } catch (error) {
    if (
      error instanceof TaypiError &&
      (error.status === 401 || error.status === 403)
    ) {
      return c.json(
        {
          error:
            "TAYPI rechazó las claves. Cópialas otra vez desde Integraciones en tu panel de TAYPI.",
          reason: "taypi_rejected_keys",
        },
        400,
      );
    }
  }

  await saveTaypiKeys(tenantId, keys);
  await logAction(
    { userId: c.get("user").id, tenantId },
    "connect_taypi",
    "system",
    null,
    { environment: taypiEnvironment(keys.publicKey) },
  );
  const expected = webhookUrl(tenantId);
  return c.json({
    connected: true,
    environment: taypiEnvironment(keys.publicKey),
    business_name: merchant?.business_name ?? null,
    webhook_matches: merchant ? merchant.webhook_url === expected : null,
    webhook_url: expected,
    domain: publicOrigin(),
  });
});

taypi.delete("/", async (c) => {
  const tenantId = activeTenantId(c);
  await clearTaypiKeys(tenantId);
  await logAction(
    { userId: c.get("user").id, tenantId },
    "disconnect_taypi",
    "system",
    null,
    {},
  );
  return c.body(null, 204);
});

export default taypi;
