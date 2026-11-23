import { Hono } from "hono";
import { reportSummary } from "../domains/reports/summary.ts";
import {
  SystemSettings,
  isTenantSecretSettingKey,
} from "../domains/settings/system.ts";
import { requirePlatformOperator } from "../middleware/auth.ts";
import { logAction } from "../platform/audit/logger.ts";
import { summaryRange } from "./reports.ts";

/**
 * VendeYa's own pages: the ones that span every business or configure the
 * deployment. A request here names no business.
 */
const platform = new Hono();

platform.use("/*", requirePlatformOperator);

/** Every open business, with a line per business. */
platform.get("/summary", async (c) => {
  const range = summaryRange(c);
  if ("problem" in range) return c.json({ error: range.problem }, 400);
  return c.json(await reportSummary({ tenantId: null, ...range }));
});

platform.get("/settings", async (c) => c.json(await SystemSettings.getAll()));

platform.post("/settings", async (c) => {
  const user = c.get("user");
  const settings = await c.req.json();

  const updates: Record<string, string> = {};
  const rejected: string[] = [];
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

  return c.json({ success: true, updates, rejected });
});

export default platform;
