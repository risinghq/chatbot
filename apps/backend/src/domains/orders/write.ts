import {
  ORDER_TRANSITIONS,
  type OrderDetail,
  type OrderSource,
  type OrderStatus,
  type Payment,
  type PaymentStatus,
  type Shipment,
} from "@vendeya/types";
import { newId } from "@vendeya/utils";
import type { Compilable } from "kysely";
import { db } from "../../db/index.ts";
import {
  movementStatements,
  runMovements,
  StockService,
} from "../stock/index.ts";
import { OrderReads } from "./read.ts";
import { DeliveryZoneService, PaymentMethodService } from "./settings.ts";
import { adForOrder } from "../ads/index.ts";

/** The first number a business's orders take. */
export const FIRST_ORDER_NUMBER = 1001;

/** A request the order cannot take, answered as 400. */
export class OrderInputError extends Error {}

/** A request the order's current state refuses, answered as 409. */
export class OrderStateError extends Error {}

/** A stocked variant, priced from the catalog unless the caller sets a price. */
export type VariantLine = {
  variantId: string;
  quantity: number;
  unitPriceCents?: number;
};

/** A line that is not a stocked variant, such as a service or a one-off item. */
export type FreeLine = {
  name: string;
  sku?: string | null;
  quantity: number;
  unitPriceCents: number;
};

export type ShipmentInput = {
  zoneId?: string | null;
  /** The fee when no zone is given. A zone sets its own. */
  feeCents?: number;
  recipientName?: string | null;
  recipientPhone?: string | null;
  addressLine: string;
  district?: string | null;
  city?: string | null;
  reference?: string | null;
};

export type NewOrder = {
  tenantId: string;
  customer: { id: string; name: string; phone: string | null };
  channelAccountId: string | null;
  source: OrderSource;
  createdBy: string | null;
  notes?: string | null;
  lines: (VariantLine | FreeLine)[];
  /** Where stocked lines are held. Defaults to the business's only location. */
  locationId?: string | null;
  /** Null for a pickup. */
  shipment?: ShipmentInput | null;
};

type LineRow = {
  variant_id: string | null;
  sku: string | null;
  name: string;
  unit_price_cents: number;
  quantity: number;
};

/** The snapshot of each line: name, SKU and price as sold. */
async function resolveLines(
  tenantId: string,
  lines: (VariantLine | FreeLine)[],
): Promise<LineRow[]> {
  if (lines.length === 0) throw new OrderInputError("an order needs a line");

  const variantIds = lines.flatMap((l) =>
    "variantId" in l ? [l.variantId] : [],
  );
  if (new Set(variantIds).size !== variantIds.length) {
    throw new OrderInputError("each variant goes on one line");
  }
  const variants = variantIds.length
    ? await db
        .selectFrom("product_variants as v")
        .innerJoin("products as p", (join) =>
          join
            .onRef("p.id", "=", "v.product_id")
            .onRef("p.tenant_id", "=", "v.tenant_id"),
        )
        .select([
          "v.id",
          "v.sku",
          "v.name as variant_name",
          "v.price_cents",
          "v.is_active",
          "p.name as product_name",
        ])
        .where("v.tenant_id", "=", tenantId)
        .where("v.id", "in", variantIds)
        .execute()
    : [];
  const byId = new Map(variants.map((v) => [v.id, v]));

  return lines.map((line) => {
    if ("variantId" in line) {
      const variant = byId.get(line.variantId);
      if (!variant) {
        throw new OrderInputError(`variant ${line.variantId} not found`);
      }
      if (!variant.is_active) {
        throw new OrderInputError(`variant ${variant.sku} is not for sale`);
      }
      return {
        variant_id: variant.id,
        sku: variant.sku,
        name: variant.variant_name
          ? `${variant.product_name} · ${variant.variant_name}`
          : variant.product_name,
        unit_price_cents: line.unitPriceCents ?? variant.price_cents,
        quantity: line.quantity,
      };
    }
    return {
      variant_id: null,
      sku: line.sku ?? null,
      name: line.name,
      unit_price_cents: line.unitPriceCents,
      quantity: line.quantity,
    };
  });
}

async function resolveLocation(
  tenantId: string,
  locationId: string | null | undefined,
): Promise<string> {
  if (locationId) {
    const location = await StockService.getLocation(tenantId, locationId);
    if (!location) throw new OrderInputError("location not found");
    return location.id;
  }
  const location = await StockService.defaultLocation(tenantId);
  if (!location) {
    throw new OrderInputError(
      "location_id is required: the business has several locations",
    );
  }
  return location.id;
}

async function resolveShipment(
  tenantId: string,
  input: ShipmentInput,
): Promise<{
  zoneId: string | null;
  zoneName: string | null;
  feeCents: number;
}> {
  if (!input.zoneId) {
    return { zoneId: null, zoneName: null, feeCents: input.feeCents ?? 0 };
  }
  const zone = await DeliveryZoneService.get(tenantId, input.zoneId);
  if (!zone) throw new OrderInputError("delivery zone not found");
  if (!zone.is_active) {
    throw new OrderInputError(`delivery zone ${zone.name} is not active`);
  }
  return { zoneId: zone.id, zoneName: zone.name, feeCents: zone.fee_cents };
}

/** The lines of an order that hold stock. */
async function stockedLines(tenantId: string, orderId: string) {
  return await db
    .selectFrom("order_lines")
    .select(["variant_id", "quantity"])
    .where("tenant_id", "=", tenantId)
    .where("order_id", "=", orderId)
    .where("variant_id", "is not", null)
    .execute();
}

/**
 * What a move to `to` does to stock: shipping takes the held units out, and
 * a pickup takes them out on delivery; cancelling before shipping releases
 * them.
 */
function stockKindFor(
  from: OrderStatus,
  to: OrderStatus,
): "ship" | "release" | null {
  if (to === "shipped" || (to === "delivered" && from === "packed")) {
    return "ship";
  }
  if (to === "cancelled" && from !== "shipped") return "release";
  return null;
}

export const OrderWrites = {
  /**
   * Writes the order, its lines, its shipment and the reservation of its
   * stocked lines in one batch. The number is the business's highest plus
   * one, read by the insert itself, and `UNIQUE(tenant_id, number)` refuses a
   * concurrent twin. Throws `OrderInputError`, or `InsufficientStockError`
   * when a line asks for more than is available.
   */
  create: async (order: NewOrder): Promise<OrderDetail> => {
    const { tenantId } = order;
    const lines = await resolveLines(tenantId, order.lines);
    const stocked = lines.filter((l) => l.variant_id !== null);
    const locationId = stocked.length
      ? await resolveLocation(tenantId, order.locationId)
      : null;
    const delivery = order.shipment
      ? await resolveShipment(tenantId, order.shipment)
      : null;

    const subtotal = lines.reduce(
      (sum, l) => sum + l.unit_price_cents * l.quantity,
      0,
    );
    const fee = delivery?.feeCents ?? 0;
    const id = newId();
    const now = Date.now();

    // An order off a conversation credits the ad the contact last clicked,
    // while the click is still inside the window.
    const ad =
      order.channelAccountId && order.customer.phone
        ? await adForOrder(
            {
              tenantId,
              channelAccountId: order.channelAccountId,
              phoneNumber: order.customer.phone,
            },
            now,
          )
        : null;

    const statements: Compilable[] = [
      db
        .insertInto("orders")
        .columns([
          "id",
          "tenant_id",
          "number",
          "customer_id",
          "channel_account_id",
          "source",
          "location_id",
          "subtotal_cents",
          "delivery_fee_cents",
          "total_cents",
          "notes",
          "ad_source_id",
          "ad_headline",
          "created_by",
          "created_at",
          "updated_at",
        ])
        .expression(
          db
            .selectFrom("orders")
            .select((eb) => [
              eb.val(id).as("id"),
              eb.val(tenantId).as("tenant_id"),
              eb(
                eb.fn.coalesce(
                  eb.fn.max("number"),
                  eb.lit(FIRST_ORDER_NUMBER - 1),
                ),
                "+",
                1,
              ).as("number"),
              eb.val(order.customer.id).as("customer_id"),
              eb.val(order.channelAccountId).as("channel_account_id"),
              eb.val(order.source).as("source"),
              eb.val(locationId).as("location_id"),
              eb.val(subtotal).as("subtotal_cents"),
              eb.val(fee).as("delivery_fee_cents"),
              eb.val(subtotal + fee).as("total_cents"),
              eb.val(order.notes ?? null).as("notes"),
              eb.val(ad?.ad_source_id ?? null).as("ad_source_id"),
              eb.val(ad?.ad_headline ?? null).as("ad_headline"),
              eb.val(order.createdBy).as("created_by"),
              eb.val(now).as("created_at"),
              eb.val(now).as("updated_at"),
            ])
            .where("tenant_id", "=", tenantId),
        ),
      db.insertInto("order_lines").values(
        lines.map((line, position) => ({
          id: newId(),
          tenant_id: tenantId,
          order_id: id,
          position,
          ...line,
        })),
      ),
    ];

    if (order.shipment && delivery) {
      const s = order.shipment;
      statements.push(
        db.insertInto("shipments").values({
          id: newId(),
          tenant_id: tenantId,
          order_id: id,
          delivery_zone_id: delivery.zoneId,
          zone_name: delivery.zoneName,
          recipient_name: s.recipientName || order.customer.name,
          recipient_phone: s.recipientPhone || order.customer.phone,
          address_line: s.addressLine,
          district: s.district ?? null,
          city: s.city ?? null,
          reference: s.reference ?? null,
        }),
      );
    }

    if (locationId) {
      statements.push(
        ...movementStatements({
          tenantId,
          locationId,
          kind: "reserve",
          items: stocked.map((l) => ({
            variantId: l.variant_id!,
            quantity: l.quantity,
          })),
          order: { id, status: "pending" },
          createdBy: order.createdBy,
        }),
      );
    }

    await runMovements(statements);
    return (await OrderReads.detail(tenantId, id))!;
  },

  /**
   * Moves the order to `to` and moves its stock (`stockKindFor`) in one batch.
   * Every statement applies only while the order is still in the status read
   * here, so of two concurrent moves one applies and the other changes
   * nothing and throws `OrderStateError`. Null when the order does not exist.
   */
  transition: async (
    tenantId: string,
    orderId: string,
    to: OrderStatus,
    userId: string | null,
  ): Promise<OrderDetail | null> => {
    const order = await db
      .selectFrom("orders")
      .select(["status", "location_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", orderId)
      .executeTakeFirst();
    if (!order) return null;

    const from = order.status;
    if (!ORDER_TRANSITIONS[from].includes(to)) {
      throw new OrderStateError(`an order cannot go from ${from} to ${to}`);
    }

    const now = Date.now();
    const guard = { id: orderId, status: from };
    const statements: Compilable[] = [];

    const kind = stockKindFor(from, to);
    if (kind && order.location_id) {
      const lines = await stockedLines(tenantId, orderId);
      statements.push(
        ...movementStatements({
          tenantId,
          locationId: order.location_id,
          kind,
          items: lines.map((l) => ({
            variantId: l.variant_id!,
            quantity: l.quantity,
          })),
          order: guard,
          createdBy: userId,
        }),
      );
    }

    if (to === "shipped" || to === "delivered") {
      statements.push(
        db
          .updateTable("shipments")
          .set(to === "shipped" ? { shipped_at: now } : { delivered_at: now })
          .where("tenant_id", "=", tenantId)
          .where("order_id", "=", orderId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("orders")
                .select(eb.lit(1).as("one"))
                .where("orders.id", "=", orderId)
                .where("orders.tenant_id", "=", tenantId)
                .where("orders.status", "=", from),
            ),
          ),
      );
    }

    statements.push(
      db
        .updateTable("orders")
        .set({ status: to, updated_at: now })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", orderId)
        .where("status", "=", from),
    );

    await runMovements(statements);

    const moved = await OrderReads.detail(tenantId, orderId);
    if (moved?.status !== to) {
      throw new OrderStateError(
        `the order changed status to ${moved?.status} meanwhile`,
      );
    }
    return moved;
  },

  /**
   * Records a payment, pending until someone confirms it. `methodId` names a
   * method of the business; `methodName` alone records one that is not set
   * up. Throws `OrderInputError`, or `OrderStateError` on a cancelled order.
   */
  addPayment: async (
    tenantId: string,
    orderId: string,
    input: {
      methodId?: string | null;
      methodName?: string | null;
      amountCents: number;
      reference?: string | null;
    },
    createdBy: string | null,
  ): Promise<Payment | null> => {
    const order = await db
      .selectFrom("orders")
      .select("status")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", orderId)
      .executeTakeFirst();
    if (!order) return null;
    if (order.status === "cancelled") {
      throw new OrderStateError("a cancelled order takes no payment");
    }

    let methodId: string | null = null;
    let methodName = input.methodName?.trim() || null;
    if (input.methodId) {
      const method = await PaymentMethodService.get(tenantId, input.methodId);
      if (!method) throw new OrderInputError("payment method not found");
      methodId = method.id;
      methodName = method.name;
    }
    if (!methodName) {
      throw new OrderInputError("a payment needs a method id or a method name");
    }

    const id = newId();
    await db
      .insertInto("payments")
      .values({
        id,
        tenant_id: tenantId,
        order_id: orderId,
        payment_method_id: methodId,
        method_name: methodName,
        amount_cents: input.amountCents,
        reference: input.reference?.trim() || null,
        created_by: createdBy,
      })
      .execute();
    return await db
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
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  },

  /**
   * Confirms or rejects a pending payment. Null when the payment is not on
   * this order. Throws `OrderStateError` when it was already decided.
   */
  decidePayment: async (
    tenantId: string,
    orderId: string,
    paymentId: string,
    status: Exclude<PaymentStatus, "pending">,
  ): Promise<OrderDetail | null> => {
    const result = await db
      .updateTable("payments")
      .set({ status, decided_at: Date.now() })
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", orderId)
      .where("id", "=", paymentId)
      .where("status", "=", "pending")
      .executeTakeFirst();

    if (result.numUpdatedRows === 0n) {
      const payment = await db
        .selectFrom("payments")
        .select("status")
        .where("tenant_id", "=", tenantId)
        .where("order_id", "=", orderId)
        .where("id", "=", paymentId)
        .executeTakeFirst();
      if (!payment) return null;
      throw new OrderStateError(`the payment is already ${payment.status}`);
    }
    return await OrderReads.detail(tenantId, orderId);
  },

  /**
   * Edits the carrier, tracking code or recipient details of an order's
   * shipment. Null when the order has no shipment.
   */
  updateShipment: async (
    tenantId: string,
    orderId: string,
    fields: Partial<
      Pick<
        Shipment,
        | "carrier"
        | "tracking_code"
        | "recipient_name"
        | "recipient_phone"
        | "address_line"
        | "district"
        | "city"
        | "reference"
      >
    >,
  ): Promise<OrderDetail | null> => {
    if (Object.keys(fields).length > 0) {
      const result = await db
        .updateTable("shipments")
        .set(fields)
        .where("tenant_id", "=", tenantId)
        .where("order_id", "=", orderId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) return null;
    }
    const order = await OrderReads.detail(tenantId, orderId);
    return order?.shipment ? order : null;
  },
};
