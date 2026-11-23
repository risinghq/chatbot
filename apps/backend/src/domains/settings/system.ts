import { db } from "../../db/index.ts";

/**
 * Keys that describe the deployment rather than any one business. A platform
 * operator with no tenant selected writes them. A tenant-scoped writer is
 * refused.
 */
export const PLATFORM_SETTING_KEYS = [
  "force_fnb_down",
  "force_gaso_down",
  "platform_ops_channel_account_id",
  "powerbi_resource_key",
  "powerbi_report_id",
  "powerbi_dataset_id",
  "powerbi_model_id",
] as const;

export function isPlatformSettingKey(key: string): boolean {
  return (PLATFORM_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * The platform values a tenant admin is shown read-only, reported as
 * `_platform_<key>` so a tenant's save cannot post them back. This is an
 * allowlist, so a key added to PLATFORM_SETTING_KEYS stays hidden from
 * tenant-scoped callers until it is named here too.
 */
export const TENANT_VISIBLE_PLATFORM_KEYS = [
  // Shared Calidda integrations, shown as disabled toggles on the dashboard.
  "force_fnb_down",
  "force_gaso_down",
] as const;

/**
 * Tenant keys the application writes as its own working state, such as the
 * round-robin cursor `last_agent_index`. A value written by hand changes where
 * the rotation resumes, so the settings route refuses these keys and leaves
 * them out of what it reads back.
 */
export const INTERNAL_TENANT_SETTING_KEYS = ["last_agent_index"] as const;

export function isInternalTenantSettingKey(key: string): boolean {
  return (INTERNAL_TENANT_SETTING_KEYS as readonly string[]).includes(key);
}

export {
  isTenantSecretSettingKey,
  TENANT_SECRET_SETTING_KEYS,
} from "@vendeya/types";

export const SystemSettings = {
  async get(key: string): Promise<string | null> {
    const row = await db
      .selectFrom("system_settings")
      .select("value")
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value ?? null;
  },

  async getAll(): Promise<Record<string, string>> {
    const rows = await db
      .selectFrom("system_settings")
      .select(["key", "value"])
      .execute();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  async set(key: string, value: string): Promise<void> {
    await db
      .insertInto("system_settings")
      .values({ key, value, updated_at: Date.now() })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet((eb) => ({
          value: eb.ref("excluded.value"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute();
  },
};

export const TenantSettings = {
  async get(tenantId: string, key: string): Promise<string | null> {
    const row = await db
      .selectFrom("tenant_settings")
      .select("value")
      .where("tenant_id", "=", tenantId)
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value ?? null;
  },

  async getAll(tenantId: string): Promise<Record<string, string>> {
    const rows = await db
      .selectFrom("tenant_settings")
      .select(["key", "value"])
      .where("tenant_id", "=", tenantId)
      .execute();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  async set(tenantId: string, key: string, value: string): Promise<void> {
    await db
      .insertInto("tenant_settings")
      .values({ tenant_id: tenantId, key, value, updated_at: Date.now() })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "key"]).doUpdateSet((eb) => ({
          value: eb.ref("excluded.value"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute();
  },
};

export type PowerBIReport = {
  resourceKey: string;
  reportId: string;
  datasetId: string;
  modelId: string;
};

/**
 * The one public Cálidda Power BI report every tenant's GASO check reads, or
 * null while any of its four ids is unset.
 */
export async function powerbiReport(): Promise<PowerBIReport | null> {
  const all = await SystemSettings.getAll();
  const report = {
    resourceKey: all.powerbi_resource_key,
    reportId: all.powerbi_report_id,
    datasetId: all.powerbi_dataset_id,
    modelId: all.powerbi_model_id,
  };
  if (Object.values(report).some((value) => !value)) return null;
  return report as PowerBIReport;
}

/**
 * Calidda's FNB and GASO endpoints are shared platform integrations, not
 * per-tenant ones, so forcing them down is a platform-level switch.
 */
export async function isProviderForcedDown(
  provider: "fnb" | "gaso",
): Promise<boolean> {
  const key = provider === "fnb" ? "force_fnb_down" : "force_gaso_down";
  return (await SystemSettings.get(key)) === "true";
}
