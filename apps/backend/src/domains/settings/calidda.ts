/**
 * A tenant's Cálidda login: the account each business holds with Cálidda's FNB
 * portal. The username and password are the tenant's own, entered on the
 * dashboard; the host is the same for every business, so it stays a platform
 * variable. A tenant with either part missing — or a platform with no base
 * URL — has no login, and its FNB checks take the unavailable path.
 */

import { env } from "cloudflare:workers";
import { TenantSecrets } from "./tenant-secrets.ts";
import { TenantSettings } from "./system.ts";

export const CALIDDA_USERNAME_KEY = "calidda_username";
export const CALIDDA_PASSWORD_KEY = "calidda_password";

export type CaliddaLogin = {
  tenantId: string;
  baseUrl: string;
  username: string;
  password: string;
};

/** The login, or null when any part is missing or unreadable. */
export async function caliddaLogin(
  tenantId: string,
): Promise<CaliddaLogin | null> {
  const baseUrl = env.CALIDDA_BASE_URL;
  const [username, password] = await Promise.all([
    TenantSettings.get(tenantId, CALIDDA_USERNAME_KEY),
    TenantSecrets.get(tenantId, CALIDDA_PASSWORD_KEY),
  ]);

  if (!baseUrl || !username || !password) return null;
  return { tenantId, baseUrl, username, password };
}
