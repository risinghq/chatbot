import { db } from "../../db/index.ts";
import { hasOpenAiApiKey } from "../settings/openai.ts";
import { TenantSettings } from "../settings/system.ts";
import { TenantSecrets } from "../settings/tenant-secrets.ts";

/**
 * What a business still needs before it can sell, in the order the dashboard
 * walks a new business through it. Each flag is read from the same rows the
 * feature itself checks, so the checklist and the running system can never
 * disagree: the assistant's OpenAI key, an active product with an active
 * variant it can sell, units of such a variant the assistant can reserve, an
 * active payment method the assistant can offer and an order can be paid
 * with, a conversation in the simulator, and a number that can receive (app
 * secret) and answer (access token).
 *
 * Cálidda credit is an optional integration, so its login is reported but
 * does not count toward `complete`. A team is optional too: the owner who
 * signed up already works the conversations.
 */
export type TenantSetupStatus = {
  openai_configured: boolean;
  has_catalog: boolean;
  has_stock: boolean;
  has_payment_methods: boolean;
  tried_simulator: boolean;
  whatsapp_configured: boolean;
  calidda_configured: boolean;
  complete: boolean;
};

/** Whether the query matches a row; it reads one row at most. */
const exists = async (query: {
  limit(n: number): { executeTakeFirst(): Promise<unknown> };
}): Promise<boolean> => (await query.limit(1).executeTakeFirst()) !== undefined;

/** The business's active variants of active products: what the assistant sells. */
const sellableVariants = (tenantId: string) =>
  db
    .selectFrom("product_variants as v")
    .innerJoin("products as p", (join) =>
      join
        .onRef("p.id", "=", "v.product_id")
        .onRef("p.tenant_id", "=", "v.tenant_id"),
    )
    .where("v.tenant_id", "=", tenantId)
    .where("v.is_active", "=", 1)
    .where("p.status", "=", "active");

export async function tenantSetupStatus(
  tenantId: string,
): Promise<TenantSetupStatus> {
  const [
    openai,
    products,
    stock,
    paymentMethods,
    simulated,
    numbers,
    caliddaPassword,
    caliddaUsername,
  ] = await Promise.all([
    hasOpenAiApiKey(tenantId),
    exists(sellableVariants(tenantId).select("v.id")),
    exists(
      sellableVariants(tenantId)
        .innerJoin("stock_levels as s", (join) =>
          join
            .onRef("s.variant_id", "=", "v.id")
            .onRef("s.tenant_id", "=", "v.tenant_id"),
        )
        .select("v.id")
        .whereRef("s.on_hand", ">", "s.reserved"),
    ),
    exists(
      db
        .selectFrom("payment_methods")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("is_active", "=", 1),
    ),
    exists(
      db
        .selectFrom("conversations as c")
        .innerJoin("channel_accounts as a", (join) =>
          join
            .onRef("a.id", "=", "c.channel_account_id")
            .onRef("a.tenant_id", "=", "c.tenant_id"),
        )
        .select("c.phone_number")
        .where("c.tenant_id", "=", tenantId)
        .where("a.channel_type", "=", "simulator"),
    ),
    exists(
      db
        .selectFrom("channel_accounts")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("channel_type", "=", "whatsapp")
        .where("access_token_secret_id", "is not", null)
        .where("app_secret_secret_id", "is not", null),
    ),
    TenantSecrets.has(tenantId, "calidda_password"),
    TenantSettings.get(tenantId, "calidda_username"),
  ]);

  const required = {
    openai_configured: openai,
    has_catalog: products,
    has_stock: stock,
    has_payment_methods: paymentMethods,
    tried_simulator: simulated,
    whatsapp_configured: numbers,
  };
  return {
    ...required,
    calidda_configured: caliddaPassword && Boolean(caliddaUsername),
    complete: Object.values(required).every(Boolean),
  };
}
