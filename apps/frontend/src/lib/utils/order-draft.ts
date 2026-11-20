import { parseCents, type DeliveryZone, type StockRow } from "@vendeya/types";

/** One line of a new order, its price as typed so an input can bind it. */
export type DraftLine = {
  variantId: string;
  label: string;
  sku: string;
  price: string;
  quantity: number;
  /** Units the chosen location can still sell. */
  available: number;
};

export type DraftAddress = {
  line: string;
  district: string;
  city: string;
  reference: string;
};

export type OrderDraft = {
  customerId: string | null;
  lines: DraftLine[];
  /** `pickup` has no shipment and no fee. */
  delivery: "pickup" | "ship";
  /** A delivery zone id, or empty for a fee typed by hand. */
  zoneId: string;
  fee: string;
  address: DraftAddress;
  /** Empty when the business has one location, which the API picks. */
  locationId: string;
  notes: string;
};

export function emptyDraft(customerId: string | null = null): OrderDraft {
  return {
    customerId,
    lines: [],
    delivery: "pickup",
    zoneId: "",
    fee: "0",
    address: { line: "", district: "", city: "", reference: "" },
    locationId: "",
    notes: "",
  };
}

export function variantLabel(row: StockRow): string {
  return row.variant_name
    ? `${row.product_name} · ${row.variant_name}`
    : row.product_name;
}

/** Adds one unit of `row`, on its existing line when there is one. */
export function addVariant(lines: DraftLine[], row: StockRow): DraftLine[] {
  if (lines.some((l) => l.variantId === row.variant_id)) {
    return lines.map((l) =>
      l.variantId === row.variant_id ? { ...l, quantity: l.quantity + 1 } : l,
    );
  }
  return [
    ...lines,
    {
      variantId: row.variant_id,
      label: variantLabel(row),
      sku: row.sku,
      price: (row.price_cents / 100).toFixed(2),
      quantity: 1,
      available: row.available,
    },
  ];
}

/** Each line's `available` re-read for another location. */
export function withAvailability(
  lines: DraftLine[],
  rows: StockRow[],
): DraftLine[] {
  const available = new Map(rows.map((r) => [r.variant_id, r.available]));
  return lines.map((l) => ({
    ...l,
    available: available.get(l.variantId) ?? 0,
  }));
}

function feeCents(
  draft: OrderDraft,
  zones: readonly DeliveryZone[],
): number | null {
  if (draft.delivery === "pickup") return 0;
  if (draft.zoneId) {
    return zones.find((z) => z.id === draft.zoneId)?.fee_cents ?? null;
  }
  return parseCents(draft.fee);
}

/** What the order will charge, or null where a typed amount does not parse. */
export function draftTotals(
  draft: OrderDraft,
  zones: readonly DeliveryZone[],
): { subtotal: number | null; fee: number | null; total: number | null } {
  let subtotal: number | null = 0;
  for (const line of draft.lines) {
    const price = parseCents(line.price);
    subtotal =
      price === null || subtotal === null
        ? null
        : subtotal + price * line.quantity;
  }
  const fee = feeCents(draft, zones);
  return {
    subtotal,
    fee,
    total: subtotal === null || fee === null ? null : subtotal + fee,
  };
}

/** Why the draft cannot be sent yet, in the order a person fixes it. */
export function draftProblems(
  draft: OrderDraft,
  zones: readonly DeliveryZone[],
): string[] {
  const problems: string[] = [];
  if (!draft.customerId) problems.push("Elige el cliente");
  if (draft.lines.length === 0) problems.push("Agrega al menos un producto");
  for (const line of draft.lines) {
    if (parseCents(line.price) === null)
      problems.push(`Revisa el precio de ${line.label}`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1)
      problems.push(`Revisa la cantidad de ${line.label}`);
    else if (line.quantity > line.available)
      problems.push(
        `Solo quedan ${Math.max(line.available, 0)} de ${line.label}`,
      );
  }
  if (draft.delivery === "ship") {
    if (!draft.address.line.trim()) problems.push("Escribe la dirección");
    if (feeCents(draft, zones) === null)
      problems.push("Revisa el costo de envío");
  }
  return problems;
}

function orNull(text: string): string | null {
  return text.trim() || null;
}

/**
 * The `POST /api/orders` body. Prices go as typed, so a line priced off the
 * catalog keeps its price. Call only when `draftProblems` is empty.
 */
export function orderBody(draft: OrderDraft, zones: readonly DeliveryZone[]) {
  const shipment =
    draft.delivery === "ship"
      ? {
          zone_id: draft.zoneId || null,
          ...(draft.zoneId ? {} : { fee_cents: feeCents(draft, zones) }),
          address_line: draft.address.line.trim(),
          district: orNull(draft.address.district),
          city: orNull(draft.address.city),
          reference: orNull(draft.address.reference),
        }
      : null;
  return {
    customer_id: draft.customerId,
    lines: draft.lines.map((l) => ({
      variant_id: l.variantId,
      quantity: l.quantity,
      unit_price_cents: parseCents(l.price),
    })),
    location_id: draft.locationId || null,
    shipment,
    notes: orNull(draft.notes),
  };
}
