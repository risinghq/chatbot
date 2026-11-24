import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ShopifyConnections } from "../domains/shopify/connection.ts";
import {
  handleShopifyWebhook,
  shopifySignatureMatches,
} from "../domains/shopify/webhook.ts";
import { pathParam } from "../lib/http.ts";
import { createLogger } from "../lib/logger.ts";

const logger = createLogger("shopify-webhook");

/**
 * Shopify's product and inventory events for one business. The path names
 * the business because each verifies against its own webhook secret.
 */
const shopifyWebhook = new Hono();

shopifyWebhook.post(
  "/:tenantId",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }),
  async (c) => {
    const tenantId = pathParam(c, "tenantId");
    const raw = await c.req.text();

    const secret = await ShopifyConnections.webhookSecret(tenantId);
    if (
      !secret ||
      !(await shopifySignatureMatches(
        raw,
        c.req.header("X-Shopify-Hmac-Sha256") ?? null,
        secret,
      ))
    ) {
      logger.warn({ tenantId }, "Shopify webhook refused: bad signature");
      return c.json({ error: "invalid_signature" }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const topic = c.req.header("X-Shopify-Topic") ?? "";
    try {
      await handleShopifyWebhook(tenantId, topic, payload);
    } catch (error) {
      // Shopify retries a 5xx, so a delivery whose work failed is answered
      // as failed rather than acknowledged and lost.
      logger.error(
        { error, tenantId, topic },
        "Shopify webhook handling failed",
      );
      return c.json({ error: "handling_failed" }, 500);
    }
    return c.json({ received: true });
  },
);

export default shopifyWebhook;
