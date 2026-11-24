import { env } from "cloudflare:workers";
import { db, tenantScope } from "../../db/index.ts";
import { TenantSecrets } from "../settings/tenant-secrets.ts";

export const SHOPIFY_TOKEN_KEY = "shopify_admin_token";
export const SHOPIFY_WEBHOOK_SECRET_KEY = "shopify_webhook_secret";

export type ShopifyConnection = {
  tenant_id: string;
  shop_domain: string;
  last_synced_at: number | null;
  created_at: number;
  updated_at: number;
};

/** The connection with the credential it calls with, or null. */
export type ShopifyLogin = ShopifyConnection & { accessToken: string };

/**
 * The domain a shop enters, normalized: the scheme, path and trailing slash
 * go, a bare handle gets `.myshopify.com`, and the result is lowercase. Null
 * when what is left is not a Shopify host.
 */
export function parseShopDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let domain = raw.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (domain === "") return null;
  if (!domain.includes(".")) domain = `${domain}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
}

/**
 * The host the Admin API calls go to. `SHOPIFY_BASE_URL` overrides it so
 * tests and local probes run against a fake; production leaves it unset and
 * the store's own domain answers.
 */
export function shopifyBaseUrl(shopDomain: string): string {
  const override = env.SHOPIFY_BASE_URL?.trim();
  return (override || `https://${shopDomain}`).replace(/\/+$/, "");
}

export const ShopifyConnections = {
  async get(tenantId: string): Promise<ShopifyConnection | null> {
    return (
      (await db
        .selectFrom("shopify_connections")
        .selectAll()
        .where(tenantScope(tenantId))
        .executeTakeFirst()) ?? null
    );
  },

  /** The connection and its token, or null while either is missing. */
  async login(tenantId: string): Promise<ShopifyLogin | null> {
    const connection = await ShopifyConnections.get(tenantId);
    if (!connection) return null;
    const accessToken = await TenantSecrets.get(tenantId, SHOPIFY_TOKEN_KEY);
    return accessToken ? { ...connection, accessToken } : null;
  },

  async webhookSecret(tenantId: string): Promise<string | null> {
    return TenantSecrets.get(tenantId, SHOPIFY_WEBHOOK_SECRET_KEY);
  },

  /** Saves the store and its secrets; connecting again replaces them. */
  async connect(
    tenantId: string,
    shopDomain: string,
    accessToken: string,
    webhookSecret: string,
  ): Promise<void> {
    await Promise.all([
      TenantSecrets.set(tenantId, SHOPIFY_TOKEN_KEY, accessToken),
      TenantSecrets.set(tenantId, SHOPIFY_WEBHOOK_SECRET_KEY, webhookSecret),
    ]);
    await db
      .insertInto("shopify_connections")
      .values({ tenant_id: tenantId, shop_domain: shopDomain })
      .onConflict((oc) =>
        oc.column("tenant_id").doUpdateSet({
          shop_domain: shopDomain,
          updated_at: Date.now(),
        }),
      )
      .execute();
  },

  async markSynced(tenantId: string, at: number): Promise<void> {
    await db
      .updateTable("shopify_connections")
      .set({ last_synced_at: at, updated_at: at })
      .where(tenantScope(tenantId))
      .execute();
  },

  /** Drops the connection and its secrets; imported rows stay catalog. */
  async disconnect(tenantId: string): Promise<void> {
    await Promise.all([
      TenantSecrets.clear(tenantId, SHOPIFY_TOKEN_KEY),
      TenantSecrets.clear(tenantId, SHOPIFY_WEBHOOK_SECRET_KEY),
      db
        .deleteFrom("shopify_connections")
        .where(tenantScope(tenantId))
        .execute(),
    ]);
  },
};
