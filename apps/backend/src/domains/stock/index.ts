import type { Compilable, ExpressionBuilder } from "kysely";
import type {
  OrderStatus,
  StockLocation,
  StockMovement,
  StockMovementKind,
  StockRow,
} from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { batch, db } from "../../db/index.ts";
import { isConstraintError } from "../../db/constraints.ts";
import type { Database } from "../../db/schema.ts";

/** The location a business gets when it records stock without naming one. */
export const DEFAULT_LOCATION_NAME = "Almacén principal";

/** A movement that would leave negative stock, or hold more than is on hand. */
export class InsufficientStockError extends Error {
  constructor() {
    super("Not enough stock for this movement");
  }
}

/** How each kind moves the two counters, for a quantity `q`. */
const DELTAS: Record<
  StockMovementKind,
  (q: number) => { onHand: number; reserved: number }
> = {
  receive: (q) => ({ onHand: q, reserved: 0 }),
  adjust: (q) => ({ onHand: q, reserved: 0 }),
  reserve: (q) => ({ onHand: 0, reserved: q }),
  release: (q) => ({ onHand: 0, reserved: -q }),
  ship: (q) => ({ onHand: -q, reserved: -q }),
};

/** Why a quantity is wrong for its kind, or null when it fits. */
export function quantityError(
  kind: StockMovementKind,
  quantity: unknown,
): string | null {
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity)) {
    return "quantity must be a whole number";
  }
  if (kind === "adjust") {
    return quantity === 0 ? "an adjustment cannot be 0" : null;
  }
  return quantity > 0 ? null : `quantity must be more than 0 for ${kind}`;
}

export const StockService = {
  listLocations: async (tenantId: string): Promise<StockLocation[]> =>
    await db
      .selectFrom("stock_locations")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .orderBy("id")
      .execute(),

  getLocation: async (
    tenantId: string,
    id: string,
  ): Promise<StockLocation | null> =>
    (await db
      .selectFrom("stock_locations")
      .selectAll()
      .where("id", "=", id)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst()) ?? null,

  /** Returns null when the business already has a location with this name. */
  createLocation: async (
    tenantId: string,
    name: string,
  ): Promise<StockLocation | null> => {
    const id = newId();
    try {
      await db
        .insertInto("stock_locations")
        .values({ id, tenant_id: tenantId, name })
        .execute();
    } catch (error) {
      if (isConstraintError(error, "UNIQUE")) return null;
      throw error;
    }
    return await StockService.getLocation(tenantId, id);
  },

  /**
   * Where a movement that names no location goes: the business's only
   * location, created on first use. Null when it has several, since picking
   * one would hide where the stock went. One statement both checks and
   * inserts, so two first movements cannot create two locations.
   */
  defaultLocation: async (tenantId: string): Promise<StockLocation | null> => {
    await db
      .insertInto("stock_locations")
      .columns(["id", "tenant_id", "name"])
      .expression(
        db
          .selectNoFrom((eb) => [
            eb.val(newId()).as("id"),
            eb.val(tenantId).as("tenant_id"),
            eb.val(DEFAULT_LOCATION_NAME).as("name"),
          ])
          .where(({ not, exists, selectFrom, lit }) =>
            not(
              exists(
                selectFrom("stock_locations")
                  .select(lit(1).as("one"))
                  .where("tenant_id", "=", tenantId),
              ),
            ),
          ),
      )
      .execute();
    const locations = await StockService.listLocations(tenantId);
    return locations.length === 1 ? locations[0]! : null;
  },

  /**
   * Every variant of the business with its stock, summed over all locations or
   * over the one given. A variant with no movement shows zeros. `productIds`
   * limits the rows to those products.
   */
  levels: async (
    tenantId: string,
    locationId?: string,
    productIds?: readonly string[],
  ): Promise<StockRow[]> => {
    if (productIds?.length === 0) return [];
    let query = db
      .selectFrom("product_variants as v")
      .innerJoin("products as p", (join) =>
        join
          .onRef("p.id", "=", "v.product_id")
          .onRef("p.tenant_id", "=", "v.tenant_id"),
      )
      .leftJoin("stock_levels as l", (join) => {
        const level = join
          .onRef("l.variant_id", "=", "v.id")
          .onRef("l.tenant_id", "=", "v.tenant_id");
        return locationId ? level.on("l.location_id", "=", locationId) : level;
      })
      .select((eb) => [
        "v.id as variant_id",
        "v.sku",
        "v.name as variant_name",
        "p.id as product_id",
        "p.name as product_name",
        "v.price_cents",
        "v.is_active",
        eb.fn.coalesce(eb.fn.sum<number>("l.on_hand"), eb.lit(0)).as("on_hand"),
        eb.fn
          .coalesce(eb.fn.sum<number>("l.reserved"), eb.lit(0))
          .as("reserved"),
        eb.fn
          .coalesce(
            eb.fn.sum<number>(eb("l.on_hand", "-", eb.ref("l.reserved"))),
            eb.lit(0),
          )
          .as("available"),
      ])
      .where("v.tenant_id", "=", tenantId);
    if (productIds) query = query.where("v.product_id", "in", productIds);
    return await query
      .groupBy("v.id")
      .orderBy("p.name")
      .orderBy("v.name")
      .orderBy("v.sku")
      .execute();
  },

  movements: async (
    tenantId: string,
    options: { variantId?: string; limit: number },
  ): Promise<StockMovement[]> =>
    await db
      .selectFrom("stock_movements")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .$if(options.variantId !== undefined, (q) =>
        q.where("variant_id", "=", options.variantId!),
      )
      .orderBy("id", "desc")
      .limit(options.limit)
      .execute(),

  /**
   * Writes the movement and moves the level in one batch. The level's CHECKs
   * refuse a result below zero, and the whole batch rolls back with them, so
   * the ledger and the level never disagree. The caller has checked that the
   * variant and location belong to the tenant and that `quantity` fits `kind`
   * (`quantityError`). Throws `InsufficientStockError` on refusal.
   */
  record: async (movement: {
    tenantId: string;
    variantId: string;
    locationId: string;
    kind: StockMovementKind;
    quantity: number;
    note?: string | null;
    createdBy: string | null;
  }): Promise<StockMovement> => {
    const id = newId();
    await runMovements(
      movementStatements({
        tenantId: movement.tenantId,
        locationId: movement.locationId,
        kind: movement.kind,
        items: [
          { id, variantId: movement.variantId, quantity: movement.quantity },
        ],
        note: movement.note || null,
        createdBy: movement.createdBy,
      }),
    );

    return await db
      .selectFrom("stock_movements")
      .selectAll()
      .where("tenant_id", "=", movement.tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  },
};

/** The order a set of movements belongs to, and the status it must be in. */
export type OrderGuard = { id: string; status: OrderStatus };

/**
 * The statements that record one movement per item and move its level, for
 * the caller to run in one batch, alone (`runMovements`) or with its own
 * writes. With `order`, each movement names the order and each statement
 * applies only while the order is in `order.status`, so a batch that lost a
 * race to move the order changes no stock.
 */
export function movementStatements(m: {
  tenantId: string;
  locationId: string;
  kind: StockMovementKind;
  items: { variantId: string; quantity: number; id?: string }[];
  order?: OrderGuard;
  note?: string | null;
  createdBy: string | null;
}): Compilable[] {
  const { tenantId, locationId, kind, order } = m;
  const orderInStatus = (eb: ExpressionBuilder<Database, any>) =>
    order
      ? eb.exists(
          eb
            .selectFrom("orders")
            .select(eb.lit(1).as("one"))
            .where("orders.id", "=", order.id)
            .where("orders.tenant_id", "=", tenantId)
            .where("orders.status", "=", order.status),
        )
      : eb.lit(true);

  return m.items.flatMap(({ variantId, quantity, id }) => {
    const delta = DELTAS[kind](quantity);
    return [
      db.insertInto("stock_levels").orIgnore().values({
        tenant_id: tenantId,
        variant_id: variantId,
        location_id: locationId,
      }),
      db
        .updateTable("stock_levels")
        .set((eb) => ({
          on_hand: eb("on_hand", "+", delta.onHand),
          reserved: eb("reserved", "+", delta.reserved),
        }))
        .where("variant_id", "=", variantId)
        .where("location_id", "=", locationId)
        .where("tenant_id", "=", tenantId)
        .where(orderInStatus),
      db
        .insertInto("stock_movements")
        .columns([
          "id",
          "tenant_id",
          "variant_id",
          "location_id",
          "kind",
          "quantity",
          "note",
          "order_id",
          "created_by",
        ])
        .expression(
          db
            .selectNoFrom((eb) => [
              eb.val(id ?? newId()).as("id"),
              eb.val(tenantId).as("tenant_id"),
              eb.val(variantId).as("variant_id"),
              eb.val(locationId).as("location_id"),
              eb.val(kind).as("kind"),
              eb.val(quantity).as("quantity"),
              eb.val(m.note ?? null).as("note"),
              eb.val(order?.id ?? null).as("order_id"),
              eb.val(m.createdBy).as("created_by"),
            ])
            .where(orderInStatus),
        ),
    ];
  });
}

/**
 * Runs a batch that moves stock. A level CHECK that refuses a result below
 * zero rolls back the whole batch and throws `InsufficientStockError`.
 */
export async function runMovements(statements: Compilable[]): Promise<void> {
  try {
    await batch(statements);
  } catch (error) {
    if (isConstraintError(error, "CHECK")) throw new InsufficientStockError();
    throw error;
  }
}

/**
 * The statements that give variants with no stock level yet their first
 * stock, as `receive` movements, packed so no statement binds more than D1's
 * 100 values. A variant that already has a level must go through
 * `movementStatements`, which adds to it.
 */
export function openingStockStatements(m: {
  tenantId: string;
  locationId: string;
  items: { variantId: string; quantity: number }[];
  note: string | null;
  createdBy: string | null;
}): Compilable[] {
  const statements: Compilable[] = [];
  const items = m.items.filter((item) => item.quantity > 0);
  for (let i = 0; i < items.length; i += 12) {
    const part = items.slice(i, i + 12);
    statements.push(
      db.insertInto("stock_levels").values(
        part.map((item) => ({
          tenant_id: m.tenantId,
          variant_id: item.variantId,
          location_id: m.locationId,
          on_hand: item.quantity,
        })),
      ),
      db.insertInto("stock_movements").values(
        part.map((item) => ({
          id: newId(),
          tenant_id: m.tenantId,
          variant_id: item.variantId,
          location_id: m.locationId,
          kind: "receive" as const,
          quantity: item.quantity,
          note: m.note,
          created_by: m.createdBy,
        })),
      ),
    );
  }
  return statements;
}
