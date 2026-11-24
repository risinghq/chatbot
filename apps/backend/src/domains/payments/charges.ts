/**
 * TAYPI charges: the checkout a customer pays an order's balance with, and
 * the confirmed payment it becomes. A charge is settled at most once, by the
 * webhook or by a status check, whichever comes first.
 */

import type { OrderDetail } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { publicOrigin } from "../../config.ts";
import { db, withoutTenantScope } from "../../db/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { OrderReads, OrderWrites } from "../orders/index.ts";
import {
  TAYPI_MAX_CENTS,
  TAYPI_MIN_CENTS,
  TaypiApi,
  centsFromTaypiAmount,
  taypiCheckoutScript,
  taypiEnvironment,
  taypiKeys,
} from "./taypi.ts";

const logger = createLogger("taypi-charges");

/** How long a pay link stays open. TAYPI takes 5 to 1440 minutes. */
const CHARGE_MINUTES = 60;

/** A pending charge closer than this to expiring is not handed out again. */
const REUSE_MARGIN_MS = 5 * 60 * 1000;

const CHECK_INTERVAL_MS = 10_000;

/** A charge this call settled: the order with the payment, and its amount. */
export type Settled = { order: OrderDetail; paidCents: number };

/** The name the confirmed payment carries on the order. */
export const TAYPI_METHOD_NAME = "TAYPI (Yape, Plin o banca)";

/**
 * How the assistant offers TAYPI: as one more payment method, with an id no
 * stored method can take, since stored ids are ULIDs.
 */
export const TAYPI_ASSISTANT_METHOD = {
  id: "taypi",
  name: "Yape, Plin o app de tu banco (link de pago)",
  instructions:
    "Al crear el pedido recibes un link de pago; envíalo al cliente. " +
    "El pago se confirma solo, sin enviar captura.",
} as const;

export type ChargeStatus = "pending" | "completed" | "expired" | "failed";

export type Charge = {
  id: string;
  tenant_id: string;
  order_id: string;
  amount_cents: number;
  checkout_token: string;
  status: ChargeStatus;
  payment_id: string | null;
  payer_name: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
};

/** Why an order gets no pay link. */
export type ChargeRefusal =
  | "not_connected"
  | "not_found"
  | "cancelled"
  | "paid"
  | "below_minimum"
  | "above_maximum";

async function find(chargeId: string): Promise<Charge | null> {
  return (
    ((await withoutTenantScope(
      "a pay link names no business; its unguessable charge id is the key",
    )
      .selectFrom("taypi_charges")
      .selectAll()
      .where("id", "=", chargeId)
      .executeTakeFirst()) as Charge | undefined) ?? null
  );
}

/** The page the customer pays a charge on. */
export function payLink(chargeId: string): string {
  return `${publicOrigin()}/pagar/${chargeId}`;
}

function balance(order: OrderDetail): number {
  return order.total_cents - order.paid_cents;
}

export const TaypiCharges = {
  /**
   * The pay link for what the order still owes: an open charge for that
   * amount when one has time left, or a new checkout session.
   */
  async open(
    tenantId: string,
    orderId: string,
  ): Promise<{ charge: Charge } | { refused: ChargeRefusal }> {
    const keys = await taypiKeys(tenantId);
    if (!keys) return { refused: "not_connected" };
    const order = await OrderReads.detail(tenantId, orderId);
    if (!order) return { refused: "not_found" };
    if (order.status === "cancelled") return { refused: "cancelled" };
    const due = balance(order);
    if (due <= 0) return { refused: "paid" };
    if (due < TAYPI_MIN_CENTS) return { refused: "below_minimum" };
    if (due > TAYPI_MAX_CENTS) return { refused: "above_maximum" };

    const open = (await db
      .selectFrom("taypi_charges")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", orderId)
      .where("status", "=", "pending")
      .where("amount_cents", "=", due)
      .where("expires_at", ">", Date.now() + REUSE_MARGIN_MS)
      .orderBy("created_at", "desc")
      .executeTakeFirst()) as Charge | undefined;
    if (open) return { charge: open };

    const business = await db
      .selectFrom("tenants")
      .select("name")
      .where("id", "=", tenantId)
      .executeTakeFirstOrThrow();
    const id = newId();
    const session = await TaypiApi.createCheckoutSession(keys, {
      reference: id,
      amountCents: due,
      description: `Pedido #${order.number} · ${business.name}`,
      expiresInMinutes: CHARGE_MINUTES,
    });
    await db
      .insertInto("taypi_charges")
      .values({
        id,
        tenant_id: tenantId,
        order_id: orderId,
        amount_cents: due,
        checkout_token: session.checkout_token,
        expires_at: Date.now() + CHARGE_MINUTES * 60 * 1000,
      })
      .execute();
    return { charge: (await find(id))! };
  },

  get: find,

  /** The open charges and past ones of an order, newest first. */
  async forOrder(tenantId: string, orderId: string): Promise<Charge[]> {
    return (await db
      .selectFrom("taypi_charges")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("order_id", "=", orderId)
      .orderBy("created_at", "desc")
      .execute()) as Charge[];
  },

  /**
   * What the public pay page shows. The public key and token are what
   * checkout.js needs and are meant for the browser.
   */
  async payPage(chargeId: string) {
    const charge = await find(chargeId);
    if (!charge) return null;
    const keys = await taypiKeys(charge.tenant_id);
    const row = await db
      .selectFrom("orders as o")
      .innerJoin("tenants as t", "t.id", "o.tenant_id")
      .select(["o.number", "t.name"])
      .where("o.tenant_id", "=", charge.tenant_id)
      .where("o.id", "=", charge.order_id)
      .executeTakeFirstOrThrow();
    const expired =
      charge.status === "pending" && charge.expires_at <= Date.now();
    return {
      business_name: row.name,
      order_number: row.number,
      amount_cents: charge.amount_cents,
      status: expired ? ("expired" as const) : charge.status,
      expires_at: charge.expires_at,
      checkout:
        keys && charge.status === "pending" && !expired
          ? {
              public_key: keys.publicKey,
              token: charge.checkout_token,
              script: taypiCheckoutScript(taypiEnvironment(keys.publicKey)),
            }
          : null,
    };
  },

  /**
   * Records what TAYPI says the customer paid. Returns the order when this
   * call settled the charge, and null when it was settled before or is not
   * the business's. A payment for another amount than the charge is kept
   * pending for staff to check against TAYPI. A payment that arrives after
   * the charge expired still counts: the money moved.
   */
  async settle(
    tenantId: string,
    chargeId: string,
    payment: {
      paymentId: string;
      amount: string;
      payerName: string | null;
    },
  ): Promise<Settled | null> {
    const claimed = await db
      .updateTable("taypi_charges")
      .set({
        status: "completed",
        payment_id: payment.paymentId,
        payer_name: payment.payerName,
        updated_at: Date.now(),
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", chargeId)
      .where("status", "in", ["pending", "expired", "failed"])
      .executeTakeFirst();
    if (claimed.numUpdatedRows === 0n) return null;
    const charge = (await find(chargeId))!;

    const paidCents = centsFromTaypiAmount(payment.amount);
    try {
      const recorded = await OrderWrites.addPayment(
        tenantId,
        charge.order_id,
        {
          methodName: TAYPI_METHOD_NAME,
          amountCents: paidCents,
          reference: payment.paymentId,
        },
        null,
      );
      if (!recorded) return null;
      if (paidCents !== charge.amount_cents) {
        logger.warn(
          { chargeId, expected: charge.amount_cents, paid: paidCents },
          "TAYPI paid another amount than the charge; left for staff",
        );
        return null;
      }
      const order = await OrderWrites.decidePayment(
        tenantId,
        charge.order_id,
        recorded.id,
        "confirmed",
      );
      return order ? { order, paidCents } : null;
    } catch (error) {
      // The money arrived; staff must see it even if the order cannot take it.
      logger.error(
        { error, chargeId, orderId: charge.order_id },
        "A TAYPI payment could not be recorded on its order",
      );
      return null;
    }
  },

  /** Marks a pending charge expired or failed, as TAYPI reported it. */
  async close(
    tenantId: string,
    chargeId: string,
    status: "expired" | "failed",
  ): Promise<void> {
    await db
      .updateTable("taypi_charges")
      .set({ status, updated_at: Date.now() })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", chargeId)
      .where("status", "=", "pending")
      .execute();
  },

  /**
   * Asks TAYPI whether a pending charge was paid, for when the webhook is
   * late or lost. Returns what this check settled. The pay page calls it, so
   * a charge is asked about at most once per CHECK_INTERVAL_MS: TAYPI allows
   * a merchant 60 requests a minute.
   */
  async check(charge: Charge): Promise<Settled | null> {
    if (charge.status !== "pending") return null;
    const keys = await taypiKeys(charge.tenant_id);
    if (!keys) return null;
    const now = Date.now();
    const claimed = await db
      .updateTable("taypi_charges")
      .set({ updated_at: now })
      .where("id", "=", charge.id)
      .where("tenant_id", "=", charge.tenant_id)
      .where("status", "=", "pending")
      .where("updated_at", "<=", now - CHECK_INTERVAL_MS)
      .executeTakeFirst();
    if (claimed.numUpdatedRows === 0n) return null;
    const payments = await TaypiApi.paymentsByReference(keys, charge.id);
    const paid = payments.find((p) => p.status === "completed");
    if (!paid) return null;
    return await TaypiCharges.settle(charge.tenant_id, charge.id, {
      paymentId: paid.payment_id,
      amount: paid.amount,
      payerName: paid.payer_display_name ?? null,
    });
  },
};
