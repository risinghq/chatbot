import type { Compilable } from "kysely";
import { batch, db, inOpenTenants } from "../../db/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { ShopifyApi, ShopifyError } from "./client.ts";
import { ShopifyConnections } from "./connection.ts";
import { TenantService } from "../tenants/index.ts";

const logger = createLogger("shopify-order-sync");

/** The statement a confirm appends to its batch: file the order for
 * write-back when the business is connected and a line is imported. Runs
 * after the order's own update, so the `confirmed` it selects is the new one.
 */
export function enqueueStatement(
  tenantId: string,
  orderId: string,
  now: number,
): Compilable {
  return db
    .insertInto("shopify_order_syncs")
    .columns([
      "tenant_id",
      "order_id",
      "next_attempt_at",
      "created_at",
      "updated_at",
    ])
    .expression((eb) =>
      eb
        .selectFrom("orders as o")
        .select((eb2) => [
          "o.tenant_id",
          "o.id",
          eb2.val(now).as("next_attempt_at"),
          eb2.val(now).as("created_at"),
          eb2.val(now).as("updated_at"),
        ])
        .where("o.tenant_id", "=", tenantId)
        .where("o.id", "=", orderId)
        .where("o.status", "=", "confirmed")
        .where((eb2) =>
          eb2.exists(
            eb2
              .selectFrom("shopify_connections as sc")
              .select(eb2.lit(1).as("one"))
              .whereRef("sc.tenant_id", "=", "o.tenant_id"),
          ),
        )
        .where((eb2) =>
          eb2.exists(
            eb2
              .selectFrom("order_lines as l")
              .innerJoin("product_variants as v", (join) =>
                join
                  .onRef("v.id", "=", "l.variant_id")
                  .onRef("v.tenant_id", "=", "l.tenant_id"),
              )
              .select(eb2.lit(1).as("one"))
              .whereRef("l.order_id", "=", "o.id")
              .whereRef("l.tenant_id", "=", "o.tenant_id")
              .where("v.shopify_variant_id", "is not", null),
          ),
        ),
    );
}

/** Minutes between attempts: 1, 2, 4… capped at an hour. */
function nextAttempt(now: number, attempts: number): number {
  return now + Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

type DueRow = {
  tenant_id: string;
  order_id: string;
  attempts: number;
};

/**
 * The orders whose write-back is due, over every open business. One claimed
 * row is one send; a claimed row nobody finishes stays `sending` until its
 * `next_attempt_at` — set a minute out at claim time — lets the next sweep
 * take it again.
 */
export async function dispatchDueShopifyOrderSyncs(
  now: number,
  limit = 20,
): Promise<void> {
  const due = await db
    .selectFrom("shopify_order_syncs")
    .select(["tenant_id", "order_id", "attempts"])
    .where("status", "in", ["pending", "sending", "failed"])
    .where("next_attempt_at", "<=", now)
    .where(inOpenTenants)
    .limit(limit)
    .execute();

  for (const row of due) {
    const claimed = await db
      .updateTable("shopify_order_syncs")
      .set({
        status: "sending",
        attempts: row.attempts + 1,
        next_attempt_at: now + 60_000,
        updated_at: now,
      })
      .where("tenant_id", "=", row.tenant_id)
      .where("order_id", "=", row.order_id)
      .where("attempts", "=", row.attempts)
      .executeTakeFirst();
    if (claimed.numUpdatedRows === 0n) continue;

    try {
      await writeBack(row);
    } catch (error) {
      logger.error(
        { error, tenantId: row.tenant_id, orderId: row.order_id },
        "Shopify order write-back failed",
      );
      await db
        .updateTable("shopify_order_syncs")
        .set({
          status: "failed",
          last_error:
            error instanceof ShopifyError
              ? error.message
              : "Shopify did not answer",
          next_attempt_at: nextAttempt(now, row.attempts + 1),
          updated_at: Date.now(),
        })
        .where("tenant_id", "=", row.tenant_id)
        .where("order_id", "=", row.order_id)
        .execute();
    }
  }
}

async function writeBack(row: DueRow): Promise<void> {
  const login = await ShopifyConnections.login(row.tenant_id);
  if (!login) {
    // The business disconnected: nothing to write to.
    await db
      .deleteFrom("shopify_order_syncs")
      .where("tenant_id", "=", row.tenant_id)
      .where("order_id", "=", row.order_id)
      .execute();
    return;
  }
  const tenant = await TenantService.getById(row.tenant_id);
  if (tenant?.status !== "active") return;

  const order = await db
    .selectFrom("orders as o")
    .innerJoin("customers as cu", (join) =>
      join
        .onRef("cu.id", "=", "o.customer_id")
        .onRef("cu.tenant_id", "=", "o.tenant_id"),
    )
    .leftJoin("shipments as s", (join) =>
      join
        .onRef("s.order_id", "=", "o.id")
        .onRef("s.tenant_id", "=", "o.tenant_id"),
    )
    .select([
      "o.id",
      "o.number",
      "o.notes",
      "o.shopify_order_id",
      "cu.name as customer_name",
      "cu.phone as customer_phone",
      "s.recipient_name",
      "s.recipient_phone",
      "s.address_line",
      "s.city",
    ])
    .where("o.tenant_id", "=", row.tenant_id)
    .where("o.id", "=", row.order_id)
    .executeTakeFirst();
  if (!order || order.shopify_order_id) {
    await db
      .updateTable("shopify_order_syncs")
      .set({ status: "synced", updated_at: Date.now() })
      .where("tenant_id", "=", row.tenant_id)
      .where("order_id", "=", row.order_id)
      .execute();
    return;
  }

  const lines = await db
    .selectFrom("order_lines as l")
    .leftJoin("product_variants as v", (join) =>
      join
        .onRef("v.id", "=", "l.variant_id")
        .onRef("v.tenant_id", "=", "l.tenant_id"),
    )
    .select([
      "l.name",
      "l.quantity",
      "l.unit_price_cents",
      "v.shopify_variant_id",
    ])
    .where("l.tenant_id", "=", row.tenant_id)
    .where("l.order_id", "=", row.order_id)
    .orderBy("l.position")
    .execute();

  const created = await ShopifyApi.createOrder(login, {
    name: `VendeYa #${order.number}`,
    note: order.notes,
    customer: order.customer_name
      ? {
          first_name: order.customer_name,
          ...(order.customer_phone ? { phone: order.customer_phone } : {}),
        }
      : null,
    line_items: lines.map((line) =>
      line.shopify_variant_id
        ? {
            variant_id: Number(line.shopify_variant_id),
            quantity: line.quantity,
          }
        : {
            title: line.name,
            price: (line.unit_price_cents / 100).toFixed(2),
            quantity: line.quantity,
          },
    ),
    ...(order.address_line
      ? {
          shipping_address: {
            name: order.recipient_name ?? order.customer_name ?? "",
            phone: order.recipient_phone,
            address1: order.address_line,
            city: order.city,
          },
        }
      : {}),
  });

  const now = Date.now();
  // The id and the sync state commit together: a partial success would
  // either lose the id or send the order to Shopify again on the retry.
  await batch([
    db
      .updateTable("shopify_order_syncs")
      .set({ status: "synced", updated_at: now })
      .where("tenant_id", "=", row.tenant_id)
      .where("order_id", "=", row.order_id),
    db
      .updateTable("orders")
      .set({ shopify_order_id: String(created.order.id), updated_at: now })
      .where("tenant_id", "=", row.tenant_id)
      .where("id", "=", row.order_id),
  ]);
  logger.info(
    {
      tenantId: row.tenant_id,
      orderId: row.order_id,
      shopifyOrderId: created.order.id,
    },
    "Order written back to Shopify",
  );
}
