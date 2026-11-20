import { getOne } from "../../db/index.ts";
import { hasOpenAiApiKey } from "../settings/openai.ts";
import { TenantSettings } from "../settings/system.ts";
import { TenantSecrets } from "../settings/tenant-secrets.ts";

/**
 * What a business still needs before it can sell, in the order the dashboard
 * walks a new business through it. Each flag is read from the same rows the
 * feature itself checks, so the checklist and the running system can never
 * disagree: the assistant's OpenAI key, an active offer it can quote, a
 * conversation in the simulator, a number that can receive (app secret) and
 * answer (access token), and at least one member to work the conversations.
 *
 * Cálidda credit is an optional integration, so its login is reported but
 * does not count toward `complete`.
 */
export type TenantSetupStatus = {
  openai_configured: boolean;
  has_catalog: boolean;
  tried_simulator: boolean;
  whatsapp_configured: boolean;
  has_members: boolean;
  calidda_configured: boolean;
  complete: boolean;
};

const count = async (sql: string, tenantId: string): Promise<number> =>
  (await getOne<{ count: number }>(sql, [tenantId]))?.count ?? 0;

export async function tenantSetupStatus(
  tenantId: string,
): Promise<TenantSetupStatus> {
  const [
    openai,
    offers,
    simulated,
    numbers,
    members,
    caliddaPassword,
    caliddaUsername,
  ] = await Promise.all([
    hasOpenAiApiKey(tenantId),
    count(
      `SELECT COUNT(*) as count FROM catalog_bundles b
       JOIN catalog_periods p ON p.id = b.period_id
       WHERE b.tenant_id = ? AND b.is_active = 1 AND p.status = 'active'`,
      tenantId,
    ),
    count(
      `SELECT COUNT(*) as count FROM conversations c
       JOIN channel_accounts a ON a.id = c.channel_account_id
       WHERE c.tenant_id = ? AND a.channel_type = 'simulator'`,
      tenantId,
    ),
    count(
      `SELECT COUNT(*) as count FROM channel_accounts
       WHERE tenant_id = ?
         AND channel_type = 'whatsapp'
         AND access_token_secret_id IS NOT NULL
         AND app_secret_secret_id IS NOT NULL`,
      tenantId,
    ),
    count(
      "SELECT COUNT(*) as count FROM tenant_memberships WHERE tenant_id = ?",
      tenantId,
    ),
    TenantSecrets.has(tenantId, "calidda_password"),
    TenantSettings.get(tenantId, "calidda_username"),
  ]);

  const required = {
    openai_configured: openai,
    has_catalog: offers > 0,
    tried_simulator: simulated > 0,
    whatsapp_configured: numbers > 0,
    has_members: members > 0,
  };
  return {
    ...required,
    calidda_configured: caliddaPassword && Boolean(caliddaUsername),
    complete: Object.values(required).every(Boolean),
  };
}
