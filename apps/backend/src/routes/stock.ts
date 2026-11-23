import { Hono } from "hono";
import {
  STOCK_MOVEMENT_KINDS,
  type StockLocation,
  type StockMovementKind,
} from "@vendeya/types";
import { jsonObject, queryLimit } from "../lib/http.ts";
import { VariantService } from "../domains/catalog/variants.ts";
import { quantityError, StockService } from "../domains/stock/index.ts";
import { logAction } from "../platform/audit/logger.ts";
import {
  activeTenantId,
  requireActiveTenant,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";

const stock = new Hono();

const requireStockWrite = requireRole("admin", "developer", "supervisor");

// Stock belongs to one business, so every route reads the pinned tenant.
stock.use("/*", requireTenantScope, requireActiveTenant);

stock.get("/", async (c) => {
  const tenantId = activeTenantId(c);
  const locationId = c.req.query("location_id") || undefined;
  if (locationId && !(await StockService.getLocation(tenantId, locationId))) {
    return c.json({ error: "Location not found" }, 404);
  }
  const productId = c.req.query("product_id") || undefined;
  return c.json(
    await StockService.levels(
      tenantId,
      locationId,
      productId ? [productId] : undefined,
    ),
  );
});

stock.get("/locations", async (c) => {
  return c.json(await StockService.listLocations(activeTenantId(c)));
});

stock.post("/locations", requireStockWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const location = await StockService.createLocation(tenantId, name);
  if (!location) {
    return c.json({ error: "A location with this name already exists" }, 409);
  }

  await logAction(
    { userId: c.get("user").id, tenantId },
    "create_stock_location",
    "stock_location",
    location.id,
    { name },
  );
  return c.json(location, 201);
});

stock.get("/movements", async (c) => {
  return c.json(
    await StockService.movements(activeTenantId(c), {
      variantId: c.req.query("variant_id") || undefined,
      limit: queryLimit(c, 100),
    }),
  );
});

stock.post("/movements", requireStockWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body)
    return c.json({ error: "Request body must be a JSON object" }, 400);

  const kind = body.kind as StockMovementKind;
  if (!STOCK_MOVEMENT_KINDS.includes(kind)) {
    return c.json(
      { error: `kind must be one of ${STOCK_MOVEMENT_KINDS.join(", ")}` },
      400,
    );
  }
  const invalidQuantity = quantityError(kind, body.quantity);
  if (invalidQuantity) return c.json({ error: invalidQuantity }, 400);
  if (
    body.note !== undefined &&
    body.note !== null &&
    typeof body.note !== "string"
  ) {
    return c.json({ error: "note must be a string" }, 400);
  }

  const variant =
    typeof body.variant_id === "string"
      ? await VariantService.getById(tenantId, body.variant_id)
      : null;
  if (!variant) return c.json({ error: "Variant not found" }, 404);

  let location: StockLocation | null;
  if (body.location_id === undefined || body.location_id === null) {
    location = await StockService.defaultLocation(tenantId);
    if (!location) {
      return c.json(
        {
          error: "location_id is required: the business has several locations",
        },
        400,
      );
    }
  } else {
    location =
      typeof body.location_id === "string"
        ? await StockService.getLocation(tenantId, body.location_id)
        : null;
    if (!location) return c.json({ error: "Location not found" }, 404);
  }

  const user = c.get("user");
  const movement = await StockService.record({
    tenantId,
    variantId: variant.id,
    locationId: location.id,
    kind,
    quantity: body.quantity as number,
    note: body.note as string | null | undefined,
    createdBy: user.id,
  });

  await logAction(
    { userId: user.id, tenantId },
    "record_stock_movement",
    "stock_movement",
    movement.id,
    { sku: variant.sku, kind, quantity: movement.quantity },
  );
  return c.json(movement, 201);
});

export default stock;
