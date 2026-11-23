import { Hono } from "hono";
import { jsonObject, pathParam, queryLimit, queryOffset } from "../lib/http.ts";
import {
  CustomerService,
  parseAddressFields,
  parseCustomerFields,
  type CustomerFields,
} from "../domains/customers/index.ts";
import { logAction } from "../platform/audit/logger.ts";
import {
  activeTenantId,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";

const customers = new Hono();

const requireCustomerWrite = requireRole(
  "admin",
  "developer",
  "supervisor",
  "sales_agent",
);

/** Deleting a customer erases their record, so it is not a sales task. */
const requireCustomerDelete = requireRole("admin", "supervisor");

customers.use("/*", requireTenantScope);

customers.get("/", async (c) => {
  return c.json(
    await CustomerService.list(activeTenantId(c), {
      search: c.req.query("search") || undefined,
      limit: queryLimit(c, 50),
      offset: queryOffset(c),
    }),
  );
});

customers.get("/:id", async (c) => {
  const customer = await CustomerService.get(
    activeTenantId(c),
    pathParam(c, "id"),
  );
  if (!customer) return c.json({ error: "Customer not found" }, 404);
  return c.json(customer);
});

customers.post("/", requireCustomerWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const fields = parseCustomerFields(body, false);
  if (typeof fields === "string") return c.json({ error: fields }, 400);

  const customer = await CustomerService.create(
    tenantId,
    fields as CustomerFields,
  );
  await logAction(
    { userId: c.get("user").id, tenantId },
    "create_customer",
    "customer",
    customer.id,
    { name: customer.name },
  );
  return c.json(customer, 201);
});

customers.patch("/:id", requireCustomerWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  const body = await jsonObject(c);
  if (!body) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const fields = parseCustomerFields(body, true);
  if (typeof fields === "string") return c.json({ error: fields }, 400);

  const customer = await CustomerService.update(tenantId, id, fields);
  if (!customer) return c.json({ error: "Customer not found" }, 404);

  await logAction(
    { userId: c.get("user").id, tenantId },
    "update_customer",
    "customer",
    id,
    { fields: Object.keys(fields) },
  );
  return c.json(customer);
});

customers.delete("/:id", requireCustomerDelete, async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  if (!(await CustomerService.delete(tenantId, id))) {
    return c.json({ error: "Customer not found" }, 404);
  }
  await logAction(
    { userId: c.get("user").id, tenantId },
    "delete_customer",
    "customer",
    id,
    {},
  );
  return c.body(null, 204);
});

customers.get("/:id/addresses", async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  if (!(await CustomerService.get(tenantId, id))) {
    return c.json({ error: "Customer not found" }, 404);
  }
  return c.json(await CustomerService.addresses(tenantId, id));
});

customers.post("/:id/addresses", requireCustomerWrite, async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  const body = await jsonObject(c);
  if (!body) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const fields = parseAddressFields(body);
  if (typeof fields === "string") return c.json({ error: fields }, 400);

  if (!(await CustomerService.get(tenantId, id))) {
    return c.json({ error: "Customer not found" }, 404);
  }
  return c.json(await CustomerService.addAddress(tenantId, id, fields), 201);
});

customers.delete(
  "/:id/addresses/:addressId",
  requireCustomerWrite,
  async (c) => {
    const deleted = await CustomerService.deleteAddress(
      activeTenantId(c),
      pathParam(c, "id"),
      pathParam(c, "addressId"),
    );
    if (!deleted) return c.json({ error: "Address not found" }, 404);
    return c.body(null, 204);
  },
);

export default customers;
