import { Hono, type Context } from "hono";
import { ORDER_STATUSES, type OrderStatus } from "@vendeya/types";
import { limaRangeEdge } from "../db/query.ts";
import { jsonObject, pathParam, queryLimit, queryOffset } from "../lib/http.ts";
import { ChannelAccountService } from "../domains/channels/accounts.ts";
import { CustomerService } from "../domains/customers/index.ts";
import { lookupConversation } from "../domains/conversations/read.ts";
import { OrderReads, OrderWrites } from "../domains/orders/index.ts";
import {
  parseOrderBody,
  parsePaymentBody,
  parseShipmentFields,
  type CustomerRef,
} from "../domains/orders/parse.ts";
import {
  TaypiCharges,
  payLink,
  type ChargeRefusal,
} from "../domains/payments/charges.ts";
import { TaypiError } from "../domains/payments/taypi.ts";
import { logAction } from "../platform/audit/logger.ts";
import { assignedAgentScope, hasRole } from "../platform/auth/scope.ts";
import { refOf } from "../conversation/store.ts";
import {
  activeTenantId,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";

const app = new Hono();

/** Taking an order, recording a payment and editing a shipment. */
const requireOrderDesk = requireRole(
  "admin",
  "developer",
  "supervisor",
  "sales_agent",
);

/** Moving an order forward moves its stock. */
const FULFILMENT_ROLES = ["admin", "developer", "supervisor"];

/** Cancelling and deciding payments change what the business is owed. */
const requireMoneyDecision = requireRole("admin", "supervisor");

app.use("/*", requireTenantScope);

function agentOf(c: Context): string | null {
  return assignedAgentScope(c.get("scope"));
}

/**
 * The order when the caller may act on it: in the active tenant and, for a
 * sales agent, one of theirs.
 */
async function reachableOrder(c: Context, id: string) {
  return await OrderReads.detail(activeTenantId(c), id, agentOf(c));
}

async function resolveCustomer(tenantId: string, ref: CustomerRef) {
  if ("id" in ref) return await CustomerService.get(tenantId, ref.id);
  return await CustomerService.upsertByPhone(tenantId, ref);
}

app.get("/metrics", async (c) => {
  return c.json(await OrderReads.metrics(activeTenantId(c), agentOf(c)));
});

app.get("/", async (c) => {
  const status = c.req.query("status") || undefined;
  if (status && !ORDER_STATUSES.includes(status as OrderStatus)) {
    return c.json(
      { error: `status must be one of ${ORDER_STATUSES.join(", ")}` },
      400,
    );
  }
  const startDate = c.req.query("startDate");
  const endDate = c.req.query("endDate");

  const orders = await OrderReads.list(
    activeTenantId(c),
    {
      status: status as OrderStatus | undefined,
      customerId: c.req.query("customer_id") || undefined,
      startMs: startDate
        ? limaRangeEdge(startDate, "start", "startDate")
        : undefined,
      endMs: endDate ? limaRangeEdge(endDate, "end", "endDate") : undefined,
      limit: queryLimit(c, 50),
      offset: queryOffset(c),
    },
    agentOf(c),
  );
  return c.json(orders);
});

app.get("/shipments", async (c) => {
  const statuses = (c.req.query("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    statuses.length === 0 ||
    statuses.some((s) => !ORDER_STATUSES.includes(s as OrderStatus))
  ) {
    return c.json(
      {
        error: `status must list one or more of ${ORDER_STATUSES.join(", ")}`,
      },
      400,
    );
  }

  const shipments = await OrderReads.shipments(
    activeTenantId(c),
    statuses as OrderStatus[],
    queryLimit(c, 100),
    agentOf(c),
  );
  return c.json(shipments);
});

app.get("/by-conversation/:phone", async (c) => {
  const scope = c.get("scope");
  const lookup = await lookupConversation(
    scope,
    pathParam(c, "phone"),
    c.req.query("channel") ?? null,
  );

  // Ambiguous is answered like missing: this feeds the conversation page, and
  // guessing a thread would attach the wrong order to it.
  if (lookup.status !== "found") return c.json({ order: null });

  const order = await OrderReads.latestForConversation(
    refOf(lookup.conversation),
    agentOf(c),
  );
  return c.json({ order });
});

app.get("/:id", async (c) => {
  const order = await OrderReads.detail(
    activeTenantId(c),
    pathParam(c, "id"),
    agentOf(c),
  );
  if (!order) return c.json({ error: "Order not found" }, 404);
  return c.json(order);
});

app.post("/", requireOrderDesk, async (c) => {
  const tenantId = activeTenantId(c);
  const body = await jsonObject(c);
  if (!body) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const input = parseOrderBody(body);
  if (typeof input === "string") return c.json({ error: input }, 400);

  if (input.channelAccountId) {
    const account = await ChannelAccountService.getById(input.channelAccountId);
    if (account?.tenant_id !== tenantId) {
      return c.json({ error: "Channel account not found" }, 404);
    }
  }

  const customer = await resolveCustomer(tenantId, input.customer);
  if (!customer) return c.json({ error: "Customer not found" }, 404);

  const user = c.get("user");
  const order = await OrderWrites.create({
    tenantId,
    customer,
    channelAccountId: input.channelAccountId,
    source: "staff",
    createdBy: user.id,
    notes: input.notes,
    lines: input.lines,
    locationId: input.locationId,
    shipment: input.shipment,
  });

  await logAction(
    { userId: user.id, tenantId },
    "create_order",
    "order",
    order.id,
    { number: order.number, total_cents: order.total_cents },
  );
  return c.json(order, 201);
});

app.post("/:id/transition", async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  const body = await jsonObject(c);
  const to = body?.status as OrderStatus;
  if (!ORDER_STATUSES.includes(to)) {
    return c.json(
      { error: `status must be one of ${ORDER_STATUSES.join(", ")}` },
      400,
    );
  }

  const scope = c.get("scope");
  const allowed =
    to === "cancelled" ? ["admin", "supervisor"] : FULFILMENT_ROLES;
  if (!hasRole(scope, allowed)) return c.json({ error: "Forbidden" }, 403);

  const user = c.get("user");
  const order = await OrderWrites.transition(tenantId, id, to, user.id);
  if (!order) return c.json({ error: "Order not found" }, 404);

  await logAction(
    { userId: user.id, tenantId },
    "transition_order",
    "order",
    id,
    { number: order.number, status: to },
  );
  return c.json(order);
});

app.post("/:id/payments", requireOrderDesk, async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  const body = await jsonObject(c);
  if (!body) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const input = parsePaymentBody(body);
  if (typeof input === "string") return c.json({ error: input }, 400);

  if (!(await reachableOrder(c, id))) {
    return c.json({ error: "Order not found" }, 404);
  }

  const user = c.get("user");
  const payment = await OrderWrites.addPayment(tenantId, id, input, user.id);
  if (!payment) return c.json({ error: "Order not found" }, 404);

  await logAction({ userId: user.id, tenantId }, "add_payment", "order", id, {
    payment_id: payment.id,
    amount_cents: payment.amount_cents,
  });
  return c.json(payment, 201);
});

/** What staff are told when an order gets no TAYPI link. */
const CHARGE_REFUSALS: Record<ChargeRefusal, string> = {
  not_connected: "Conecta TAYPI en Ajustes › Pagos para crear links de pago",
  not_found: "Order not found",
  cancelled: "Un pedido cancelado no se cobra",
  paid: "El pedido ya está pagado",
  below_minimum: "TAYPI cobra desde S/ 1.00",
  above_maximum: "TAYPI cobra hasta S/ 500.00 por pago; usa otro medio",
};

/** A TAYPI pay link for what the order still owes, to send the customer. */
app.post("/:id/taypi-link", requireOrderDesk, async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  if (!(await reachableOrder(c, id))) {
    return c.json({ error: "Order not found" }, 404);
  }
  let opened: Awaited<ReturnType<typeof TaypiCharges.open>>;
  try {
    opened = await TaypiCharges.open(tenantId, id);
  } catch (error) {
    if (!(error instanceof TaypiError)) throw error;
    return c.json({ error: `TAYPI no abrió el cobro: ${error.message}` }, 502);
  }
  if ("refused" in opened) {
    const status = opened.refused === "not_found" ? 404 : 400;
    return c.json(
      { error: CHARGE_REFUSALS[opened.refused], reason: opened.refused },
      status,
    );
  }
  return c.json(
    {
      url: payLink(opened.charge.id),
      amount_cents: opened.charge.amount_cents,
      expires_at: opened.charge.expires_at,
    },
    201,
  );
});

for (const [action, status] of [
  ["confirm", "confirmed"],
  ["reject", "rejected"],
] as const) {
  app.post(
    `/:id/payments/:paymentId/${action}`,
    requireMoneyDecision,
    async (c) => {
      const tenantId = activeTenantId(c);
      const id = pathParam(c, "id");
      const paymentId = pathParam(c, "paymentId");

      const order = await OrderWrites.decidePayment(
        tenantId,
        id,
        paymentId,
        status,
      );
      if (!order) return c.json({ error: "Payment not found" }, 404);

      const user = c.get("user");
      await logAction(
        { userId: user.id, tenantId },
        `${action}_payment`,
        "order",
        id,
        { payment_id: paymentId },
      );
      return c.json(order);
    },
  );
}

app.patch("/:id/shipment", requireOrderDesk, async (c) => {
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  const body = await jsonObject(c);
  if (!body) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const fields = parseShipmentFields(body);
  if (typeof fields === "string") return c.json({ error: fields }, 400);

  if (!(await reachableOrder(c, id))) {
    return c.json({ error: "Order not found" }, 404);
  }

  const order = await OrderWrites.updateShipment(tenantId, id, fields);
  if (!order) return c.json({ error: "The order has no shipment" }, 404);

  const user = c.get("user");
  await logAction(
    { userId: user.id, tenantId },
    "update_shipment",
    "order",
    id,
    fields,
  );
  return c.json(order);
});

export default app;
