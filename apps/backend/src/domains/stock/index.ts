import type {
  StockLocation,
  StockMovement,
  StockMovementKind,
  StockRow,
} from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { batch, db } from "../../db/index.ts";
import { isConstraintError } from "../../db/constraints.ts";

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
   * over the one given. A variant with no movement shows zeros.
   */
  levels: async (tenantId: string, locationId?: string): Promise<StockRow[]> =>
    await db
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
      .where("v.tenant_id", "=", tenantId)
      .groupBy("v.id")
      .orderBy("p.name")
      .orderBy("v.name")
      .orderBy("v.sku")
      .execute(),

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
    const { tenantId, variantId, locationId, kind, quantity } = movement;
    const delta = DELTAS[kind](quantity);
    const id = newId();

    try {
      await batch([
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
          .where("tenant_id", "=", tenantId),
        db.insertInto("stock_movements").values({
          id,
          tenant_id: tenantId,
          variant_id: variantId,
          location_id: locationId,
          kind,
          quantity,
          note: movement.note || null,
          created_by: movement.createdBy,
        }),
      ]);
    } catch (error) {
      if (isConstraintError(error, "CHECK")) throw new InsufficientStockError();
      throw error;
    }

    return await db
      .selectFrom("stock_movements")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  },
};
