export type StockLocation = {
  id: string;
  tenant_id: string;
  name: string;
  created_at: number;
};

/**
 * - `receive` adds stock on hand.
 * - `adjust` corrects stock on hand by a signed quantity, after a count.
 * - `reserve` holds stock for an order; `release` returns the hold.
 * - `ship` takes held stock out: it lowers both on hand and reserved.
 */
export type StockMovementKind =
  | "receive"
  | "adjust"
  | "reserve"
  | "release"
  | "ship";

export const STOCK_MOVEMENT_KINDS: readonly StockMovementKind[] = [
  "receive",
  "adjust",
  "reserve",
  "release",
  "ship",
];

export type StockMovement = {
  id: string;
  tenant_id: string;
  variant_id: string;
  location_id: string;
  kind: StockMovementKind;
  quantity: number;
  note: string | null;
  /** The order a reserve, release or ship belongs to. */
  order_id: string | null;
  created_by: string | null;
  created_at: number;
};

/** One variant's stock, summed over the locations asked for. */
export type StockRow = {
  variant_id: string;
  sku: string;
  variant_name: string | null;
  product_id: string;
  product_name: string;
  price_cents: number;
  on_hand: number;
  reserved: number;
  /** On hand minus reserved: what can still be sold. */
  available: number;
};
