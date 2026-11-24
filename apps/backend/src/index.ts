import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { CATALOG_IMAGE_CACHE_CONTROL } from "./adapters/storage/images.ts";
import { initializeApplication } from "./bootstrap/index.ts";
import { publicOrigin } from "./config.ts";
import { isCatalogImageKey } from "./lib/storage-paths.ts";
import { requireAuth, requireRole } from "./middleware/auth.ts";
import { errorHandler } from "./middleware/error.ts";
import { securityHeaders } from "./middleware/security.ts";
import admin from "./routes/admin.ts";
import assets from "./routes/assets.ts";
import assistant from "./routes/assistant.ts";
import auth from "./routes/auth.ts";
import campaigns from "./routes/campaigns.ts";
import catalog from "./routes/catalog.ts";
import conversations from "./routes/conversations.ts";
import customers from "./routes/customers.ts";
import { deliveryZones, paymentMethods } from "./routes/order-settings.ts";
import health from "./routes/health.ts";
import history from "./routes/history.ts";
import orders from "./routes/orders.ts";
import pay from "./routes/pay.ts";
import platform from "./routes/platform.ts";
import providerRoutes from "./routes/providers.ts";
import reports from "./routes/reports.ts";
import simulator from "./routes/simulator.ts";
import stock from "./routes/stock.ts";
import taypiWebhook from "./routes/taypi-webhook.ts";
import tenants from "./routes/tenants.ts";
import webhook from "./routes/webhook.ts";
import { sweep } from "./sweep.ts";

export { ConversationObject } from "./conversation/object.ts";

initializeApplication();

const app = new Hono();

app.use("/*", securityHeaders);
app.use("/*", cors({ origin: () => publicOrigin(), credentials: true }));

/**
 * Only catalog images are public, because Meta fetches an outgoing image's
 * link with no credentials. Contracts and recordings sit under other prefixes
 * and are reachable only through /api/assets/:id, which checks tenant scope.
 */
app.get("/media/:key{.+}", async (c) => {
  const key = c.req.param("key");
  if (!isCatalogImageKey(key)) return c.notFound();

  const object = await env.FILES.get(key);
  if (!object) return c.notFound();

  return c.body(object.body, 200, {
    "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
    "Cache-Control": CATALOG_IMAGE_CACHE_CONTROL,
    ETag: object.httpEtag,
  });
});

app.route("/api/health", health);
app.route("/api/webhook/taypi", taypiWebhook);
app.route("/api/webhook", webhook);
app.route("/api/auth", auth);
app.route("/api/pay", pay);

app.use("/api/*", requireAuth);
app.route("/api/tenants", tenants);
app.route("/api/assets", assets);
app.route("/api/simulator", simulator);
app.route("/api/assistant", assistant);
app.route("/api/conversations", conversations);
app.route("/api/catalog", catalog);
app.route("/api/stock", stock);
app.route("/api/orders", orders);
app.route("/api/customers", customers);
app.route("/api/delivery-zones", deliveryZones);
app.route("/api/payment-methods", paymentMethods);
app.route("/api/campaigns", campaigns);

app.route("/api/history", history);

app.use("/api/admin/*", requireRole("admin"));
app.route("/api/admin", admin);

app.route("/api/reports", reports);
app.route("/api/providers", providerRoutes);
app.route("/api/platform", platform);

app.onError(errorHandler);

export { app };

export default {
  fetch: app.fetch,
  scheduled(controller, _env, ctx) {
    ctx.waitUntil(sweep(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
