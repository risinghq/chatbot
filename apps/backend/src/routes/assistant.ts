import { Hono } from "hono";
import { jsonObject } from "../lib/http.ts";
import {
  AssistantSettingsService,
  parseAssistantFields,
  UnknownLocationError,
} from "../domains/assistant/settings.ts";
import { logAction } from "../platform/audit/logger.ts";
import {
  activeTenantId,
  requireActiveTenant,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";

const assistant = new Hono();

// The assistant's settings belong to one business.
assistant.use("/*", requireTenantScope, requireActiveTenant);

assistant.get("/settings", async (c) => {
  return c.json(await AssistantSettingsService.get(activeTenantId(c)));
});

assistant.put(
  "/settings",
  requireRole("admin", "developer", "supervisor"),
  async (c) => {
    const tenantId = activeTenantId(c);
    const body = await jsonObject(c);
    if (!body) return c.json({ error: "body must be a JSON object" }, 400);
    const fields = parseAssistantFields(body);
    if (typeof fields === "string") return c.json({ error: fields }, 400);

    const userId = c.get("user").id;
    try {
      const settings = await AssistantSettingsService.update(
        tenantId,
        fields,
        userId,
      );
      await logAction(
        { userId, tenantId },
        "update_assistant_settings",
        "assistant_settings",
        tenantId,
        { fields: Object.keys(fields) },
      );
      return c.json(settings);
    } catch (error) {
      if (error instanceof UnknownLocationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  },
);

export default assistant;
