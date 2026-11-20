/**
 * Tenant keys whose value is a secret. The settings route encrypts them into
 * `tenant_secrets`, never `tenant_settings`, and the settings read reports only
 * whether each is set. A client keeps them out of command lines and logs.
 */
export const TENANT_SECRET_SETTING_KEYS = [
  "calidda_password",
  "openai_api_key",
] as const;

export function isTenantSecretSettingKey(key: string): boolean {
  return (TENANT_SECRET_SETTING_KEYS as readonly string[]).includes(key);
}
