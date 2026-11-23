import { Hono } from "hono";
import { jsonObject, pathParam } from "../lib/http.ts";
import {
  DeliveryZoneService,
  PaymentMethodService,
  parseMethodFields,
  parseZoneFields,
} from "../domains/orders/index.ts";
import { logAction } from "../platform/audit/logger.ts";
import {
  activeTenantId,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";

type Service<T, F> = {
  list: (tenantId: string) => Promise<T[]>;
  get: (tenantId: string, id: string) => Promise<T | null>;
  create: (tenantId: string, fields: F) => Promise<T>;
  update: (
    tenantId: string,
    id: string,
    fields: Partial<F>,
  ) => Promise<T | null>;
  delete: (tenantId: string, id: string) => Promise<boolean>;
};

const requireSettingsWrite = requireRole("admin", "developer", "supervisor");

/**
 * List, read, create, update and delete for a setting a business keeps one
 * list of. Sales agents read it to fill in orders.
 */
function settingRoutes<T extends { id: string }, F>(
  entity: string,
  service: Service<T, F>,
  parse: (
    body: Record<string, unknown>,
    partial: boolean,
  ) => Partial<F> | string,
) {
  const app = new Hono();
  app.use("/*", requireTenantScope);

  app.get("/", async (c) => c.json(await service.list(activeTenantId(c))));

  app.get("/:id", async (c) => {
    const row = await service.get(activeTenantId(c), pathParam(c, "id"));
    if (!row) return c.json({ error: `${entity} not found` }, 404);
    return c.json(row);
  });

  app.post("/", requireSettingsWrite, async (c) => {
    const tenantId = activeTenantId(c);
    const body = await jsonObject(c);
    if (!body) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const fields = parse(body, false);
    if (typeof fields === "string") return c.json({ error: fields }, 400);

    const row = await service.create(tenantId, fields as F);
    await logAction(
      { userId: c.get("user").id, tenantId },
      `create_${entity}`,
      entity,
      row.id,
      fields as Record<string, unknown>,
    );
    return c.json(row, 201);
  });

  app.patch("/:id", requireSettingsWrite, async (c) => {
    const tenantId = activeTenantId(c);
    const id = pathParam(c, "id");
    const body = await jsonObject(c);
    if (!body) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }
    const fields = parse(body, true);
    if (typeof fields === "string") return c.json({ error: fields }, 400);

    const row = await service.update(tenantId, id, fields);
    if (!row) return c.json({ error: `${entity} not found` }, 404);
    await logAction(
      { userId: c.get("user").id, tenantId },
      `update_${entity}`,
      entity,
      id,
      fields as Record<string, unknown>,
    );
    return c.json(row);
  });

  app.delete("/:id", requireSettingsWrite, async (c) => {
    const tenantId = activeTenantId(c);
    const id = pathParam(c, "id");
    if (!(await service.delete(tenantId, id))) {
      return c.json({ error: `${entity} not found` }, 404);
    }
    await logAction(
      { userId: c.get("user").id, tenantId },
      `delete_${entity}`,
      entity,
      id,
      {},
    );
    return c.body(null, 204);
  });

  return app;
}

export const deliveryZones = settingRoutes(
  "delivery_zone",
  DeliveryZoneService,
  parseZoneFields,
);

export const paymentMethods = settingRoutes(
  "payment_method",
  PaymentMethodService,
  parseMethodFields,
);
