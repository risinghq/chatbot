import { db } from "../../db/index.ts";
import { hasOpenAiApiKey } from "../settings/openai.ts";
import { TenantSettings } from "../settings/system.ts";
import { TenantSecrets } from "../settings/tenant-secrets.ts";

/**
 * What a business still needs before it can sell, in the order the dashboard
 * walks a new business through it. Each flag is read from the same rows the
 * feature itself checks, so the checklist and the running system can never
 * disagree: the assistant's OpenAI key, an active product with an active
 * variant it can sell, an active payment method the assistant can offer and
 * an order can be paid with, a conversation in the simulator, a number that can
 * receive (app secret) and answer (access token), and at least one member to
 * work the conversations.
 *
 * Cálidda credit is an optional integration, so its login is reported but
 * does not count toward `complete`.
 */
export type TenantSetupStatus = {
  openai_configured: boolean;
  has_catalog: boolean;
  has_payment_methods: boolean;
  tried_simulator: boolean;
  whatsapp_configured: boolean;
  has_members: boolean;
  calidda_configured: boolean;
  complete: boolean;
};

/** Whether the query matches a row; it reads one row at most. */
const exists = async (query: {
  limit(n: number): { executeTakeFirst(): Promise<unknown> };
}): Promise<boolean> => (await query.limit(1).executeTakeFirst()) !== undefined;

export async function tenantSetupStatus(
  tenantId: string,
): Promise<TenantSetupStatus> {
  const [
    openai,
    products,
    paymentMethods,
    simulated,
    numbers,
    members,
    caliddaPassword,
    caliddaUsername,
  ] = await Promise.all([
    hasOpenAiApiKey(tenantId),
    exists(
      db
        .selectFrom("products as p")
        .select("p.id")
        .where("p.tenant_id", "=", tenantId)
        .where("p.status", "=", "active")
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom("product_variants as v")
              .select("v.id")
              .whereRef("v.tenant_id", "=", "p.tenant_id")
              .whereRef("v.product_id", "=", "p.id")
              .where("v.is_active", "=", 1),
          ),
        ),
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
    exists(
      db
        .selectFrom("tenant_memberships")
        .select("id")
        .where("tenant_id", "=", tenantId),
    ),
    TenantSecrets.has(tenantId, "calidda_password"),
    TenantSettings.get(tenantId, "calidda_username"),
  ]);

  const required = {
    openai_configured: openai,
    has_catalog: products,
    has_payment_methods: paymentMethods,
    tried_simulator: simulated,
    whatsapp_configured: numbers,
    has_members: members,
  };
  return {
    ...required,
    calidda_configured: caliddaPassword && Boolean(caliddaUsername),
    complete: Object.values(required).every(Boolean),
  };
}
