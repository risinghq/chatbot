import type {
  StockLocation,
  StockMovement,
  StockMovementKind,
  StockRow,
} from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { batch, getAll, getOne, run, stmt } from "../../db/index.ts";
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
    await getAll<StockLocation>(
      `SELECT * FROM stock_locations WHERE tenant_id = ? ORDER BY id`,
      [tenantId],
    ),

  getLocation: async (
    tenantId: string,
    id: string,
  ): Promise<StockLocation | null> =>
    (await getOne<StockLocation>(
      `SELECT * FROM stock_locations WHERE id = ? AND tenant_id = ?`,
      [id, tenantId],
    )) ?? null,

  /** Returns null when the business already has a location with this name. */
  createLocation: async (
    tenantId: string,
    name: string,
  ): Promise<StockLocation | null> => {
    const id = newId();
    try {
      await run(
        `INSERT INTO stock_locations (id, tenant_id, name) VALUES (?, ?, ?)`,
        [id, tenantId, name],
      );
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
    await run(
      `INSERT INTO stock_locations (id, tenant_id, name)
       SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM stock_locations WHERE tenant_id = ?)`,
      [newId(), tenantId, DEFAULT_LOCATION_NAME, tenantId],
    );
    const locations = await StockService.listLocations(tenantId);
    return locations.length === 1 ? locations[0]! : null;
  },

  /**
   * Every variant of the business with its stock, summed over all locations or
   * over the one given. A variant with no movement shows zeros.
   */
  levels: async (tenantId: string, locationId?: string): Promise<StockRow[]> =>
    await getAll<StockRow>(
      `SELECT v.id AS variant_id, v.sku, v.name AS variant_name,
              p.id AS product_id, p.name AS product_name, v.price_cents,
              COALESCE(SUM(l.on_hand), 0) AS on_hand,
              COALESCE(SUM(l.reserved), 0) AS reserved,
              COALESCE(SUM(l.on_hand - l.reserved), 0) AS available
       FROM product_variants v
       JOIN products p ON p.id = v.product_id AND p.tenant_id = v.tenant_id
       LEFT JOIN stock_levels l ON l.variant_id = v.id AND l.tenant_id = v.tenant_id
         ${locationId ? "AND l.location_id = ?" : ""}
       WHERE v.tenant_id = ?
       GROUP BY v.id
       ORDER BY p.name, v.name, v.sku`,
      locationId ? [locationId, tenantId] : [tenantId],
    ),

  movements: async (
    tenantId: string,
    options: { variantId?: string; limit: number },
  ): Promise<StockMovement[]> =>
    await getAll<StockMovement>(
      `SELECT * FROM stock_movements
       WHERE tenant_id = ? ${options.variantId ? "AND variant_id = ?" : ""}
       ORDER BY id DESC LIMIT ?`,
      options.variantId
        ? [tenantId, options.variantId, options.limit]
        : [tenantId, options.limit],
    ),

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
        stmt(
          `INSERT OR IGNORE INTO stock_levels (tenant_id, variant_id, location_id)
           VALUES (?, ?, ?)`,
          [tenantId, variantId, locationId],
        ),
        stmt(
          `UPDATE stock_levels
           SET on_hand = on_hand + ?, reserved = reserved + ?
           WHERE variant_id = ? AND location_id = ? AND tenant_id = ?`,
          [delta.onHand, delta.reserved, variantId, locationId, tenantId],
        ),
        stmt(
          `INSERT INTO stock_movements
             (id, tenant_id, variant_id, location_id, kind, quantity, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            tenantId,
            variantId,
            locationId,
            kind,
            quantity,
            movement.note || null,
            movement.createdBy,
          ],
        ),
      ]);
    } catch (error) {
      if (isConstraintError(error, "CHECK")) throw new InsufficientStockError();
      throw error;
    }

    return (await getOne<StockMovement>(
      `SELECT * FROM stock_movements WHERE tenant_id = ? AND id = ?`,
      [tenantId, id],
    ))!;
  },
};
