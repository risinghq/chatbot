import { getOne } from "../../db/index.ts";
import { hasOpenAiApiKey } from "../settings/openai.ts";
import { TenantSettings } from "../settings/system.ts";
import { TenantSecrets } from "../settings/tenant-secrets.ts";

/**
 * What a business still needs before it can sell. Each flag is read from the
 * same rows the feature itself checks, so the dashboard's checklist and the
 * running system can never disagree: the bot's OpenAI key, a number that can
 * receive (app secret) and answer (access token), the Cálidda login the FNB
 * check logs in with, and at least one member to work the conversations.
 */
export type TenantSetupStatus = {
  openai_configured: boolean;
  whatsapp_configured: boolean;
  calidda_configured: boolean;
  has_members: boolean;
  complete: boolean;
};

export async function tenantSetupStatus(
  tenantId: string,
): Promise<TenantSetupStatus> {
  const [openai, whatsapp, caliddaPassword, caliddaUsername, members] =
    await Promise.all([
      hasOpenAiApiKey(tenantId),
      getOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM channel_accounts
         WHERE tenant_id = ?
           AND access_token_secret_id IS NOT NULL
           AND app_secret_secret_id IS NOT NULL`,
        [tenantId],
      ),
      TenantSecrets.has(tenantId, "calidda_password"),
      TenantSettings.get(tenantId, "calidda_username"),
      getOne<{ count: number }>(
        "SELECT COUNT(*) as count FROM tenant_memberships WHERE tenant_id = ?",
        [tenantId],
      ),
    ]);

  const status = {
    openai_configured: openai,
    whatsapp_configured: (whatsapp?.count ?? 0) > 0,
    calidda_configured: caliddaPassword && Boolean(caliddaUsername),
    has_members: (members?.count ?? 0) > 0,
    complete: false,
  };
  status.complete =
    status.openai_configured &&
    status.whatsapp_configured &&
    status.calidda_configured &&
    status.has_members;
  return status;
}
