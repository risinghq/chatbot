import { Hono } from "hono";
import { jsonObject, pathParam } from "../lib/http.ts";
import { logAction } from "../platform/audit/logger.ts";
import {
  activeTenantId,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";
import {
  parseAudience,
  resolveAudience,
} from "../domains/campaigns/audience.ts";
import {
  parseParams,
  parseTemplateFields,
  TemplateService,
} from "../domains/campaigns/templates.ts";
import { CampaignService } from "../domains/campaigns/campaigns.ts";
import {
  getReminderSettings,
  saveReminderSettings,
} from "../domains/campaigns/reminders.ts";
import { isOptedOut, setOptOut } from "../domains/campaigns/consent.ts";
import { CustomerService } from "../domains/customers/index.ts";
import type { ParamBinding, ReminderSettings } from "@vendeya/types";

const campaigns = new Hono();

const requireCampaignWrite = requireRole("admin", "supervisor");

campaigns.use("/*", requireTenantScope);

// Templates

campaigns.get("/templates", async (c) => {
  return c.json(await TemplateService.list(activeTenantId(c)));
});

campaigns.post("/templates", requireCampaignWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body)
    return c.json({ error: "Request body must be a JSON object" }, 400);
  const fields = parseTemplateFields(body);
  if (typeof fields === "string") return c.json({ error: fields }, 400);

  const created = await TemplateService.create(
    tenantId,
    fields,
    c.get("user").id,
  );
  if ("error" in created) {
    return c.json(
      { error: `Meta refused the template: ${created.error}` },
      502,
    );
  }
  await logAction(
    { userId: c.get("user").id, tenantId },
    "create_template",
    "message_template",
    created.id,
    { name: created.name },
  );
  return c.json(created, 201);
});

// Campaigns

campaigns.post("/audience-count", async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body)
    return c.json({ error: "Request body must be a JSON object" }, 400);
  const audience = parseAudience(body.audience);
  if (typeof audience === "string") return c.json({ error: audience }, 400);
  const targets = await resolveAudience(tenantId, audience, Date.now());
  return c.json({ count: targets.length });
});

campaigns.get("/", async (c) => {
  return c.json(await CampaignService.list(activeTenantId(c)));
});

campaigns.post("/", requireCampaignWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body)
    return c.json({ error: "Request body must be a JSON object" }, 400);

  if (typeof body.name !== "string" || body.name.trim() === "") {
    return c.json({ error: "name must be a non-empty string" }, 400);
  }
  if (typeof body.template_id !== "string") {
    return c.json({ error: "template_id required" }, 400);
  }
  const audience = parseAudience(body.audience);
  if (typeof audience === "string") return c.json({ error: audience }, 400);

  let scheduled_at: number | null = null;
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    const at = Number(body.scheduled_at);
    if (!Number.isFinite(at) || at <= Date.now()) {
      return c.json(
        { error: "scheduled_at must be a future timestamp (ms)" },
        400,
      );
    }
    scheduled_at = at;
  }

  let params: ParamBinding[] | undefined;
  if (body.params !== undefined) {
    const template = await TemplateService.get(tenantId, body.template_id);
    if (!template) return c.json({ error: "template_not_found" }, 404);
    const parsed = parseParams(body.params, template.body);
    if (typeof parsed === "string") return c.json({ error: parsed }, 400);
    params = parsed;
  }

  const created = await CampaignService.create(
    tenantId,
    {
      name: body.name.trim(),
      template_id: body.template_id,
      audience,
      params,
      scheduled_at,
    },
    c.get("user").id,
  );
  if ("error" in created) {
    const status = created.status === 404 ? 404 : 409;
    return c.json({ error: created.error }, status);
  }
  await logAction(
    { userId: c.get("user").id, tenantId },
    "create_campaign",
    "campaign",
    created.id,
    { name: created.name },
  );
  return c.json(created, 201);
});

campaigns.get("/:id", async (c) => {
  const campaign = await CampaignService.get(
    activeTenantId(c),
    pathParam(c, "id"),
  );
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  return c.json(campaign);
});

campaigns.post("/:id/cancel", requireCampaignWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  if (!(await CampaignService.cancel(tenantId, id))) {
    return c.json({ error: "Campaign not found or already sent" }, 404);
  }
  await logAction(
    { userId: c.get("user").id, tenantId },
    "cancel_campaign",
    "campaign",
    id,
  );
  return c.json({ ok: true });
});

// Reminder and consent settings

campaigns.get("/settings/reminders", async (c) => {
  return c.json(await getReminderSettings(activeTenantId(c)));
});

function parseReminders(
  body: Record<string, unknown>,
): ReminderSettings | string {
  const int = (v: unknown, min: number, max: number) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  const section = (key: string) =>
    typeof body[key] === "object" && body[key] !== null
      ? (body[key] as Record<string, unknown>)
      : null;
  const cart = section("abandoned_cart");
  const inactive = section("inactive");
  if (!cart || !inactive) return "abandoned_cart and inactive are required";
  if (
    typeof cart.enabled !== "boolean" ||
    typeof inactive.enabled !== "boolean"
  ) {
    return "enabled must be a boolean";
  }
  if (!int(cart.hours, 1, 24 * 30))
    return "abandoned_cart.hours must be 1 to 720";
  if (!int(inactive.days, 1, 3650)) return "inactive.days must be 1 to 3650";
  const tpl = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (cart.enabled && !tpl(cart.template_id))
    return "abandoned_cart needs a template_id";
  if (inactive.enabled && !tpl(inactive.template_id))
    return "inactive needs a template_id";
  const interval = Number(body.marketing_min_interval_days);
  if (!int(interval, 1, 90))
    return "marketing_min_interval_days must be 1 to 90";
  return {
    abandoned_cart: {
      enabled: cart.enabled as boolean,
      hours: cart.hours as number,
      template_id: tpl(cart.template_id),
    },
    inactive: {
      enabled: inactive.enabled as boolean,
      days: inactive.days as number,
      template_id: tpl(inactive.template_id),
    },
    marketing_min_interval_days: interval,
  };
}

campaigns.put("/settings/reminders", requireCampaignWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body)
    return c.json({ error: "Request body must be a JSON object" }, 400);
  const settings = parseReminders(body);
  if (typeof settings === "string") return c.json({ error: settings }, 400);
  await saveReminderSettings(tenantId, settings);
  await logAction(
    { userId: c.get("user").id, tenantId },
    "update_reminders",
    "tenant_settings",
    tenantId,
  );
  return c.json(settings);
});

// A customer's marketing opt-out, addressed by customer id.

campaigns.get("/customers/:id/opt-out", async (c) => {
  const tenantId = activeTenantId(c);
  const customer = await CustomerService.get(tenantId, pathParam(c, "id"));
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  const optedOut = customer.phone
    ? await isOptedOut(tenantId, customer.phone)
    : false;
  return c.json({ optedOut });
});

campaigns.put("/customers/:id/opt-out", async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body || typeof body.optedOut !== "boolean") {
    return c.json({ error: "optedOut must be a boolean" }, 400);
  }
  const customer = await CustomerService.get(tenantId, pathParam(c, "id"));
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  if (!customer.phone)
    return c.json({ error: "The customer has no phone" }, 409);
  await setOptOut(tenantId, customer.phone, body.optedOut, "staff");
  await logAction(
    { userId: c.get("user").id, tenantId },
    body.optedOut ? "opt_out_customer" : "opt_in_customer",
    "customer",
    customer.id,
  );
  return c.json({ ok: true });
});

export default campaigns;
