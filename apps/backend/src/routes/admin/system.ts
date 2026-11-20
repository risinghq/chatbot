import { Hono } from "hono";
import { tenantPredicate } from "../../db/query.ts";
import {
  auditActorLabel,
  logAction,
  getAuditTrail,
} from "../../platform/audit/logger.ts";
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
import { getRecentLLMCalls } from "../../intelligence/tracker.ts";
import { queryLimit } from "../../lib/http.ts";
import {
  activeTenantId,
  requireActiveTenant,
  requireTenantScope,
} from "../../middleware/auth.ts";
import { getAll } from "../../db/index.ts";

const system = new Hono();

system.use("/*", requireTenantScope);

system.get("/llm-errors", async (c) => {
  const scope = c.get("scope");
  const phoneFilter = c.req.query("phone");
  const operationFilter = c.req.query("operation");
  const limit = queryLimit(c, 100);

  const conditions = ["status = 'error'"];
  const params: (string | number)[] = [];

  conditions.push(tenantPredicate(scope.tenantId));
  if (scope.tenantId) params.push(scope.tenantId);

  if (phoneFilter) {
    conditions.push("phone_number = ?");
    params.push(phoneFilter);
  }
  if (operationFilter) {
    conditions.push("operation = ?");
    params.push(operationFilter);
  }

  params.push(limit);

  const errors = await getAll<{
    id: string;
    phone_number: string;
    operation: string;
    error_type: string | null;
    error_message: string | null;
    conversation_phase: string | null;
    context_metadata: string | null;
    created_at: string;
  }>(
    `SELECT id, phone_number, operation, error_type, error_message,
            conversation_phase, context_metadata, created_at
     FROM llm_calls
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT ?`,
    params,
  );

  return c.json({
    errors: errors.map((e) => ({
      ...e,
      metadata: e.context_metadata ? JSON.parse(e.context_metadata) : null,
    })),
  });
});

system.get("/llm-calls", async (c) => {
  const limit = queryLimit(c, 50);
  return c.json({
    calls: await getRecentLLMCalls(c.get("scope").tenantId, limit),
  });
});

system.get("/audit", async (c) => {
  const scope = c.get("scope");
  const userIdFilter = c.req.query("user_id");
  const limit = queryLimit(c, 100);

  const logs = await getAuditTrail(scope.tenantId, userIdFilter, limit);

  const userIds = [
    ...new Set(logs.flatMap((l) => (l.user_id === null ? [] : [l.user_id]))),
  ];
  const dbUsers = userIds.length
    ? await getAll<{ id: string; email: string; name: string }>(
        `SELECT id, email, name FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`,
        userIds,
      )
    : [];

  const userMap = new Map(dbUsers.map((u) => [u.id, u]));

  const logsWithNames = logs.map((log) => {
    const user = log.user_id === null ? undefined : userMap.get(log.user_id);

    return {
      ...log,
      user_name: auditActorLabel(user?.name, log.actor),
      user_email: user?.email || null,
    };
  });

  return c.json({ logs: logsWithNames });
});

/**
 * What the active business still needs before it can sell. The dashboard's
 * setup checklist reads this; a caller with no tenant pinned has no business
 * to report on, so `activeTenantId` refuses it.
 */
system.get("/setup-status", requireActiveTenant, async (c) => {
  return c.json(await tenantSetupStatus(activeTenantId(c)));
});

system.get("/settings", async (c) => {
  const scope = c.get("scope");
  const platform = await SystemSettings.getAll();

  if (!scope.tenantId) {
    // A platform operator with no tenant selected reads every platform setting
    // under its own name.
    return c.json({ ...platform, _scope: "platform" });
  }

  // The dashboard posts back whatever this returns. Internal rows are dropped
  // here as well as refused on the write, so a save never resubmits the
  // round-robin cursor and gets its own read back in `rejected`. Tenant secret
  // keys are dropped too: a stored password's ciphertext never leaves the
  // server, and a plaintext row written straight into `tenant_settings` would
  // otherwise be handed to the browser.
  const tenant = Object.fromEntries(
    Object.entries(await TenantSettings.getAll(scope.tenantId)).filter(
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
            (await TenantSecrets.has(scope.tenantId!, key)) ? "true" : "false",
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
  const scope = c.get("scope");
  const settings = await c.req.json();

  const updates: Record<string, string> = {};
  const rejected: string[] = [];

  if (!scope.tenantId) {
    // Platform operator, no tenant selected: writes land on platform config.
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith("_")) continue;
      // A tenant secret has no meaning at platform scope, and storing it here
      // would keep a plaintext password.
      if (isTenantSecretSettingKey(key)) {
        rejected.push(key);
        continue;
      }
      await SystemSettings.set(key, String(value));
      updates[key] = String(value);
    }

    await logAction(
      { userId: user.id, tenantId: null },
      "update_platform_settings",
      "system",
      null,
      updates,
    );

    return c.json({ success: true, updates, rejected, scope: "platform" });
  }

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
        await TenantSecrets.set(scope.tenantId, key, text);
        updates[key] = "<stored>";
      } else {
        await TenantSecrets.clear(scope.tenantId, key);
        updates[key] = "<cleared>";
      }
      continue;
    }
    await TenantSettings.set(scope.tenantId, key, String(value));
    updates[key] = String(value);
  }

  // A changed Cálidda login must not keep the old account's session token or
  // a block the old credentials caused. The next check re-authenticates.
  if (Object.keys(settings).some((key) => key.startsWith("calidda_"))) {
    await clearFnbState(scope.tenantId);
  }

  await logAction(
    { userId: user.id, tenantId: scope.tenantId },
    "update_settings",
    "system",
    null,
    updates,
  );

  return c.json({ success: true, updates, rejected, scope: "tenant" });
});

export default system;
