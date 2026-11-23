import {
  ORDER_STATUSES,
  paymentState,
  type ConversationRef,
  type OrderDetail,
  type OrderMetrics,
  type OrderStatus,
  type OrderSummary,
  type ShipmentSummary,
} from "@vendeya/types";
import { sql, type ExpressionBuilder } from "kysely";
import { db, tenantScope } from "../../db/index.ts";
import { withoutTenantScope } from "../../db/index.ts";

export type OrderFilters = {
  status?: OrderStatus;
  customerId?: string;
  /** Inclusive bounds on `created_at`, in ms. */
  startMs?: number;
  endMs?: number;
  /** Absent for an export, which reads every matching order. */
  limit?: number;
  offset?: number;
};

/**
 * A sales agent's orders: the ones they created, and the ones whose
 * conversation is assigned to them. An order reaches its conversation by the
 * business, the number it came through and the customer's phone.
 */
function agentOrders(eb: ExpressionBuilder<any, any>, agentId: string) {
  return eb.or([
    eb("o.created_by", "=", agentId),
    eb.exists(
      eb
        .selectFrom("conversations as cv")
        .select(eb.lit(1).as("one"))
        .whereRef("cv.tenant_id", "=", "o.tenant_id")
        .whereRef("cv.channel_account_id", "=", "o.channel_account_id")
        .whereRef("cv.phone_number", "=", "cu.phone")
        .where("cv.assigned_agent", "=", agentId),
    ),
  ]);
}

/** Confirmed payments of the order `o`. */
function paidCents(eb: ExpressionBuilder<any, any>) {
  return eb
    .selectFrom("payments as pay")
    .select(
      eb.fn
        .coalesce(eb.fn.sum<number>("pay.amount_cents"), eb.lit(0))
        .as("paid"),
    )
    .whereRef("pay.order_id", "=", "o.id")
    .whereRef("pay.tenant_id", "=", "o.tenant_id")
    .where("pay.status", "=", "confirmed");
}

/** Orders with their buyer in `tenantId`, narrowed to `agentId`'s when set. */
function scopedOrders(tenantId: string, agentId: string | null) {
  return db
    .selectFrom("orders as o")
    .innerJoin("customers as cu", (join) =>
      join
        .onRef("cu.id", "=", "o.customer_id")
        .onRef("cu.tenant_id", "=", "o.tenant_id"),
    )
    .where(tenantScope(tenantId, "o.tenant_id"))
    .$if(agentId !== null, (q) => q.where((eb) => agentOrders(eb, agentId!)));
}

function summaries(tenantId: string, agentId: string | null) {
  return scopedOrders(tenantId, agentId)
    .selectAll("o")
    .select((eb) => [
      "cu.name as customer_name",
      "cu.phone as customer_phone",
      paidCents(eb).as("paid_cents"),
    ]);
}

function withPaymentState<
  T extends { paid_cents: number | null; total_cents: number },
>(
  row: T,
): T & { paid_cents: number; payment_state: OrderSummary["payment_state"] } {
  const paid = row.paid_cents ?? 0;
  return {
    ...row,
    paid_cents: paid,
    payment_state: paymentState(paid, row.total_cents),
  };
}

export const OrderReads = {
  /** Newest first. `agentId` narrows to a sales agent's orders. */
  list: async (
    tenantId: string,
    filters: OrderFilters,
    agentId: string | null = null,
  ): Promise<OrderSummary[]> => {
    const rows = await summaries(tenantId, agentId)
      .$if(filters.status !== undefined, (q) =>
        q.where("o.status", "=", filters.status!),
      )
      .$if(filters.customerId !== undefined, (q) =>
        q.where("o.customer_id", "=", filters.customerId!),
      )
      .$if(filters.startMs !== undefined, (q) =>
        q.where("o.created_at", ">=", filters.startMs!),
      )
      .$if(filters.endMs !== undefined, (q) =>
        q.where("o.created_at", "<=", filters.endMs!),
      )
      .orderBy("o.id", "desc")
      .$if(filters.limit !== undefined, (q) =>
        q.limit(filters.limit!).offset(filters.offset ?? 0),
      )
      .execute();
    return rows.map(withPaymentState) as OrderSummary[];
  },

  /**
   * Shipments of orders in `statuses`, newest order first. A pickup order has
   * no shipment, so it is not listed. `agentId` narrows to a sales agent's
   * orders.
   */
  shipments: async (
    tenantId: string,
    statuses: readonly OrderStatus[],
    limit: number,
    agentId: string | null = null,
  ): Promise<ShipmentSummary[]> => {
    const rows = await scopedOrders(tenantId, agentId)
      .innerJoin("shipments as s", (join) =>
        join
          .onRef("s.order_id", "=", "o.id")
          .onRef("s.tenant_id", "=", "o.tenant_id"),
      )
      .select((eb) => [
        "s.id",
        "s.order_id",
        "s.delivery_zone_id",
        "s.zone_name",
        "s.recipient_name",
        "s.recipient_phone",
        "s.address_line",
        "s.district",
        "s.city",
        "s.reference",
        "s.carrier",
        "s.tracking_code",
        "s.shipped_at",
        "s.delivered_at",
        "s.created_at",
        "o.number as order_number",
        "o.status as order_status",
        "o.total_cents",
        "cu.name as customer_name",
        "cu.phone as customer_phone",
        paidCents(eb).as("paid_cents"),
      ])
      .where("o.status", "in", [...statuses])
      .orderBy("o.id", "desc")
      .limit(limit)
      .execute();
    return rows.map(withPaymentState) as ShipmentSummary[];
  },

  /** `agentId` narrows to a sales agent's orders. */
  detail: async (
    tenantId: string,
    id: string,
    agentId: string | null = null,
  ): Promise<OrderDetail | null> => {
    const row = await summaries(tenantId, agentId)
      .where("o.id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    const order = withPaymentState(row) as OrderSummary;
    const owner = order.tenant_id;

    const [customer, lines, payments, shipment, creator] = await Promise.all([
      db
        .selectFrom("customers")
        .selectAll()
        .where("tenant_id", "=", owner)
        .where("id", "=", order.customer_id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("order_lines")
        .select([
          "id",
          "order_id",
          "variant_id",
          "sku",
          "name",
          "unit_price_cents",
          "quantity",
          "position",
        ])
        .where("tenant_id", "=", owner)
        .where("order_id", "=", id)
        .orderBy("position")
        .execute(),
      db
        .selectFrom("payments")
        .select([
          "id",
          "order_id",
          "payment_method_id",
          "method_name",
          "amount_cents",
          "status",
          "reference",
          "created_by",
          "created_at",
          "decided_at",
        ])
        .where("tenant_id", "=", owner)
        .where("order_id", "=", id)
        .orderBy("id")
        .execute(),
      db
        .selectFrom("shipments")
        .select([
          "id",
          "order_id",
          "delivery_zone_id",
          "zone_name",
          "recipient_name",
          "recipient_phone",
          "address_line",
          "district",
          "city",
          "reference",
          "carrier",
          "tracking_code",
          "shipped_at",
          "delivered_at",
          "created_at",
        ])
        .where("tenant_id", "=", owner)
        .where("order_id", "=", id)
        .executeTakeFirst(),
      order.created_by
        ? withoutTenantScope("users are global, keyed by id")
            .selectFrom("users")
            .select("name")
            .where("id", "=", order.created_by)
            .executeTakeFirst()
        : undefined,
    ]);

    return {
      ...order,
      customer,
      lines,
      payments,
      shipment: shipment ?? null,
      created_by_name: creator?.name ?? null,
    };
  },

  /**
   * The newest order from this conversation: its business, number and
   * customer phone. `agentId` narrows to a sales agent's orders.
   */
  latestForConversation: async (
    ref: ConversationRef,
    agentId: string | null = null,
  ): Promise<OrderSummary | null> => {
    const row = await summaries(ref.tenantId, agentId)
      .where("o.channel_account_id", "=", ref.channelAccountId)
      .where("cu.phone", "=", ref.phoneNumber)
      .orderBy("o.id", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? (withPaymentState(row) as OrderSummary) : null;
  },

  /** `agentId` narrows to a sales agent's orders. */
  metrics: async (
    tenantId: string,
    agentId: string | null = null,
  ): Promise<OrderMetrics> => {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const scoped = scopedOrders(tenantId, agentId);

    const [counts, totals] = await Promise.all([
      scoped
        .select((eb) => ["o.status", eb.fn.countAll<number>().as("n")])
        .groupBy("o.status")
        .execute(),
      scoped
        .select((eb) => [
          sql<number>`coalesce(sum(case when o.status = 'delivered' then o.total_cents end), 0)`.as(
            "delivered",
          ),
          sql<number>`coalesce(sum(case when o.status = 'delivered' and o.created_at >= ${since} then o.total_cents end), 0)`.as(
            "recent",
          ),
          sql<number>`coalesce(sum(case when o.status != 'cancelled' then max(o.total_cents - (${paidCents(eb)}), 0) end), 0)`.as(
            "outstanding",
          ),
        ])
        .executeTakeFirstOrThrow(),
    ]);

    const byStatus = Object.fromEntries(
      ORDER_STATUSES.map((status) => [status, 0]),
    ) as Record<OrderStatus, number>;
    for (const { status, n } of counts) byStatus[status] = n;

    return {
      byStatus,
      deliveredCents: totals.delivered,
      deliveredCentsLast30Days: totals.recent,
      outstandingCents: totals.outstanding,
    };
  },
};
