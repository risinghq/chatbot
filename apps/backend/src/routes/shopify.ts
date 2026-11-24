import { Hono } from "hono";
import { publicOrigin } from "../config.ts";
import { ShopifyApi, ShopifyError } from "../domains/shopify/client.ts";
import {
  parseShopDomain,
  ShopifyConnections,
} from "../domains/shopify/connection.ts";
import { syncFromShopify } from "../domains/shopify/sync.ts";
import { jsonObject } from "../lib/http.ts";
import { createLogger } from "../lib/logger.ts";
import { activeTenantId, requireTenantScope } from "../middleware/auth.ts";
import { logAction } from "../platform/audit/logger.ts";

const logger = createLogger("shopify");

const shopify = new Hono();

shopify.use("/*", requireTenantScope);

/** Where Shopify posts this business's product and inventory events. */
function webhookUrl(tenantId: string): string {
  return `${publicOrigin()}/api/webhook/shopify/${tenantId}`;
}

/** Whether Shopify is connected, when it last synced and where webhooks go. */
shopify.get("/", async (c) => {
  const tenantId = activeTenantId(c);
  const connection = await ShopifyConnections.get(tenantId);
  return c.json({
    connected: connection !== null,
    shop_domain: connection?.shop_domain ?? null,
    last_synced_at: connection?.last_synced_at ?? null,
    webhook_url: webhookUrl(tenantId),
  });
});

/**
 * Saves the store and its secrets once Shopify accepts the token. Only a
 * refusal (401, 403) stops the save: an outage must not keep a business from
 * connecting.
 */
shopify.put("/", async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const shopDomain = parseShopDomain(body.shop_domain);
  const accessToken =
    typeof body.access_token === "string" ? body.access_token.trim() : "";
  const webhookSecret =
    typeof body.webhook_secret === "string" ? body.webhook_secret.trim() : "";
  if (!shopDomain) {
    return c.json(
      { error: "El dominio debe ser como mitienda.myshopify.com" },
      400,
    );
  }
  if (!accessToken) {
    return c.json(
      { error: "Pega el token de Admin API de tu app de Shopify" },
      400,
    );
  }
  if (!webhookSecret) {
    return c.json(
      {
        error:
          "Pega el secreto que Shopify muestra en Notificaciones › Webhooks",
      },
      400,
    );
  }

  let shopName: string | null = null;
  try {
    const shop = await ShopifyApi.shop({
      tenant_id: tenantId,
      shop_domain: shopDomain,
      accessToken,
      last_synced_at: null,
      created_at: 0,
      updated_at: 0,
    });
    shopName = shop.shop.name;
  } catch (error) {
    if (
      error instanceof ShopifyError &&
      (error.status === 401 || error.status === 403)
    ) {
      return c.json(
        {
          error:
            "Shopify rechazó el token. Cópialo otra vez desde tu app en Configuración › Apps.",
          reason: "shopify_rejected_token",
        },
        400,
      );
    }
    logger.warn(
      { error, tenantId, shopDomain },
      "Shopify shop check failed; saving anyway",
    );
  }

  await ShopifyConnections.connect(
    tenantId,
    shopDomain,
    accessToken,
    webhookSecret,
  );
  await logAction(
    { userId: c.get("user").id, tenantId },
    "connect_shopify",
    "system",
    null,
    { shop_domain: shopDomain },
  );
  return c.json({
    connected: true,
    shop_domain: shopDomain,
    shop_name: shopName,
    last_synced_at: null,
    webhook_url: webhookUrl(tenantId),
  });
});

/** Brings the store's catalog and stock now; the answer is the summary. */
shopify.post("/sync", async (c) => {
  const tenantId = activeTenantId(c);
  if (!(await ShopifyConnections.get(tenantId))) {
    return c.json({ error: "Shopify no está conectado" }, 409);
  }
  try {
    return c.json(await syncFromShopify(tenantId));
  } catch (error) {
    logger.error({ error, tenantId }, "Shopify sync failed");
    return c.json({ error: "Shopify no respondió; inténtalo de nuevo" }, 502);
  }
});

shopify.delete("/", async (c) => {
  const tenantId = activeTenantId(c);
  await ShopifyConnections.disconnect(tenantId);
  await logAction(
    { userId: c.get("user").id, tenantId },
    "disconnect_shopify",
    "system",
    null,
    {},
  );
  return c.body(null, 204);
});

export default shopify;
