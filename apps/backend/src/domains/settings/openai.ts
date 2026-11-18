/**
 * The tenant's own OpenAI key, entered on the dashboard and stored encrypted
 * in `tenant_secrets`. There is no platform key: a tenant with none takes the
 * AI-unavailable path, the same as an outage.
 */

import { TenantSecrets } from "./tenant-secrets.ts";

export const OPENAI_API_KEY_SETTING = "openai_api_key";

/** The tenant's key, or null while none is stored or it cannot be read. */
export function openAiApiKey(tenantId: string): Promise<string | null> {
  return TenantSecrets.get(tenantId, OPENAI_API_KEY_SETTING);
}

/** True only when the stored key can be read with the current SECRETS_KEY. */
export async function hasOpenAiApiKey(tenantId: string): Promise<boolean> {
  return (await TenantSecrets.get(tenantId, OPENAI_API_KEY_SETTING)) !== null;
}
