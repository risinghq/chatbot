import { Hono } from "hono";
import { logAction } from "../../platform/audit/logger.ts";
import {
  SystemSettings,
  TenantSettings,
  isInternalTenantSettingKey,
  isPlatformSettingKey,
  isTenantSecretSettingKey,
  TENANT_SECRET_SETTING_KEYS,
  TENANT_VISIBLE_PLATFORM_KEYS,
} from "../../domains/settings/system.ts";
import { TenantSecrets } from "../../domains/settings/tenant-secrets.ts";
import {
  OPENAI_API_KEY_SETTING,
  openAiRejectsKey,
} from "../../domains/settings/openai.ts";
import { tenantSetupStatus } from "../../domains/tenants/setup.ts";
import { clearFnbState } from "../../adapters/providers/fnb-client.ts";
import { queryLimit } from "../../lib/http.ts";
import { activeTenantId, requireTenantScope } from "../../middleware/auth.ts";
import { db, tenantScope } from "../../db/index.ts";

const system = new Hono();

system.use("/*", requireTenantScope);

system.get("/llm-errors", async (c) => {
  const tenantId = activeTenantId(c);
  const phoneFilter = c.req.query("phone");
  const operationFilter = c.req.query("operation");
  const limit = queryLimit(c, 100);

  const errors = await db
    .selectFrom("llm_calls")
    .select([
      "id",
      "phone_number",
      "operation",
      "error_type",
      "error_message",
      "context_metadata",
      "created_at",
    ])
    .where("status", "=", "error")
    .where(tenantScope(tenantId))
    .$if(Boolean(phoneFilter), (q) =>
      q.where("phone_number", "=", phoneFilter!),
    )
    .$if(Boolean(operationFilter), (q) =>
      q.where("operation", "=", operationFilter!),
    )
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();

  return c.json({
    errors: errors.map((e) => ({
      ...e,
      metadata: e.context_metadata ? JSON.parse(e.context_metadata) : null,
    })),
  });
});

/**
 * What the active business still needs before it can sell. The dashboard's
 * setup checklist reads this.
 */
system.get("/setup-status", async (c) => {
  return c.json(await tenantSetupStatus(activeTenantId(c)));
});

system.get("/settings", async (c) => {
  const tenantId = activeTenantId(c);
  const platform = await SystemSettings.getAll();

  // The dashboard posts back whatever this returns. Internal rows are dropped
  // here as well as refused on the write, so a save never resubmits the
  // round-robin cursor and gets its own read back in `rejected`. Tenant secret
  // keys are dropped too: a stored password's ciphertext never leaves the
  // server, and a plaintext row written straight into `tenant_settings` would
  // otherwise be handed to the browser.
  const tenant = Object.fromEntries(
    Object.entries(await TenantSettings.getAll(tenantId)).filter(
      ([key]) =>
        !isInternalTenantSettingKey(key) && !isTenantSecretSettingKey(key),
    ),
  );

  // A secret is reported as set or not, never as a value. The `_` prefix keeps
  // the indicator out of the next save, like the platform values below.
  const secretIndicators = Object.fromEntries(
    await Promise.all(
      TENANT_SECRET_SETTING_KEYS.map(
        async (key) =>
          [
            `_has_${key}`,
            (await TenantSecrets.has(tenantId, key)) ? "true" : "false",
          ] as const,
      ),
    ),
  );

  // Only the platform values in TENANT_VISIBLE_PLATFORM_KEYS leave the platform
  // scope. The rest, such as `platform_ops_channel_account_id`, is deployment
  // configuration that a tenant admin must not read.
  const visiblePlatform = Object.fromEntries(
    TENANT_VISIBLE_PLATFORM_KEYS.map((key) => [
      // POST /settings skips keys that start with "_". The dashboard can render
      // a platform value under this name but cannot post it back. An unprefixed
      // platform key would be posted back on the next save and be refused into
      // `rejected`.
      `_platform_${key}`,
      platform[key] ?? "false",
    ]),
  );

  return c.json({
    ...tenant,
    ...visiblePlatform,
    ...secretIndicators,
    _scope: "tenant",
  });
});

system.post("/settings", async (c) => {
  const user = c.get("user");
  const tenantId = activeTenantId(c);
  const settings = await c.req.json();

  const updates: Record<string, string> = {};
  const rejected: string[] = [];

  // Checked before anything is written, so a wrong key fails the whole save
  // and the business hears it now, not in a customer's conversation.
  const openAiKey = settings[OPENAI_API_KEY_SETTING];
  if (openAiKey && (await openAiRejectsKey(String(openAiKey)))) {
    return c.json(
      {
        error: "OpenAI rechazó la clave. Revisa que esté completa y activa.",
        reason: "invalid_openai_key",
      },
      400,
    );
  }

  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith("_")) continue;
    // Tenant-scoped writers cannot write platform keys.
    if (isPlatformSettingKey(key)) {
      rejected.push(key);
      continue;
    }
    // `tenant_settings` is one flat table, and the application keeps its own
    // working state in it. A hand-written value changes where that state
    // resumes (see INTERNAL_TENANT_SETTING_KEYS).
    if (isInternalTenantSettingKey(key)) {
      rejected.push(key);
      continue;
    }
    // A secret is encrypted into `tenant_secrets`, never stored or echoed back.
    // An empty value clears it, so the audit entry names the change, not the
    // password.
    if (isTenantSecretSettingKey(key)) {
      const text = String(value);
      if (text) {
        await TenantSecrets.set(tenantId, key, text);
        updates[key] = "<stored>";
      } else {
        await TenantSecrets.clear(tenantId, key);
        updates[key] = "<cleared>";
      }
      continue;
    }
    await TenantSettings.set(tenantId, key, String(value));
    updates[key] = String(value);
  }

  // A changed Cálidda login must not keep the old account's session token or
  // a block the old credentials caused. The next check re-authenticates.
  if (Object.keys(settings).some((key) => key.startsWith("calidda_"))) {
    await clearFnbState(tenantId);
  }

  await logAction(
    { userId: user.id, tenantId },
    "update_settings",
    "system",
    null,
    updates,
  );

  return c.json({ success: true, updates, rejected, scope: "tenant" });
});

export default system;
