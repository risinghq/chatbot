import { Hono } from "hono";
import {
  getCommentReplySettings,
  parseCommentReplySettings,
  saveCommentReplySettings,
} from "../../domains/instagram/comments.ts";
import { jsonObject } from "../../lib/http.ts";
import { activeTenantId, requireTenantScope } from "../../middleware/auth.ts";
import { logAction } from "../../platform/audit/logger.ts";

const instagram = new Hono();

instagram.use("/*", requireTenantScope);

/** How the business's Instagram accounts answer comments on their posts. */
instagram.get("/comments", async (c) => {
  return c.json(await getCommentReplySettings(activeTenantId(c)));
});

instagram.put("/comments", async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body) return c.json({ error: "body must be a JSON object" }, 400);
  const settings = parseCommentReplySettings(body);
  if (typeof settings === "string") return c.json({ error: settings }, 400);

  await saveCommentReplySettings(tenantId, settings);
  await logAction(
    { userId: c.get("user").id, tenantId },
    "update_instagram_comment_replies",
    "tenant_settings",
    tenantId,
    { enabled: settings.enabled },
  );
  return c.json(settings);
});

export default instagram;
