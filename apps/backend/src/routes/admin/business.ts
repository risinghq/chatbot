import { isBusinessKind, type BusinessKind } from "@vendeya/types";
import { Hono } from "hono";
import { TenantService } from "../../domains/tenants/index.ts";
import { logAction } from "../../platform/audit/logger.ts";
import { activeTenantId, requireTenantScope } from "../../middleware/auth.ts";

const business = new Hono();

business.use("/*", requireTenantScope);

/** The open business's name and what it sells, set by its admin. */
business.patch("/", async (c) => {
  const tenantId = activeTenantId(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const fields: { name?: string; business_kind?: BusinessKind } = {};
  if (body.name !== undefined) {
    const checked = TenantService.checkName(body.name);
    if ("problem" in checked) return c.json({ error: checked.problem }, 400);
    fields.name = checked.name;
  }
  if (body.business_kind !== undefined) {
    if (!isBusinessKind(body.business_kind)) {
      return c.json({ error: "business_kind is not a known kind" }, 400);
    }
    fields.business_kind = body.business_kind;
  }
  if (Object.keys(fields).length === 0) {
    return c.json({ error: "Nothing to change" }, 400);
  }

  const tenant = await TenantService.update(tenantId, fields);
  await logAction(
    { userId: c.get("user").id, tenantId },
    "update_business",
    "tenant",
    tenantId,
    fields,
  );
  return c.json(tenant);
});

export default business;
