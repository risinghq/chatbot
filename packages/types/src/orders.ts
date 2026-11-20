export type DocumentType = "dni" | "ce" | "ruc" | "passport";

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  "dni",
  "ce",
  "ruc",
  "passport",
];

export type Customer = {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  document_type: DocumentType | null;
  document_number: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
};

/** A customer in a list, with how much they bought. */
export type CustomerSummary = Customer & {
  order_count: number;
  /** Sum of the totals of their orders that were not cancelled. */
  spent_cents: number;
};

export type CustomerAddress = {
  id: string;
  customer_id: string;
  line: string;
  district: string | null;
  city: string | null;
  reference: string | null;
  created_at: number;
};

export type DeliveryZone = {
  id: string;
  tenant_id: string;
  name: string;
  fee_cents: number;
  is_active: 0 | 1;
  created_at: number;
};

export type PaymentMethod = {
  id: string;
  tenant_id: string;
  name: string;
  instructions: string | null;
  is_active: 0 | 1;
  created_at: number;
};

/**
 * - `pending`: placed; its stocked lines are reserved.
 * - `confirmed`: the business accepted it.
 * - `packed`: ready to hand to the carrier or the customer.
 * - `shipped`: on its way; the reserved units left stock.
 * - `delivered`: the customer has it.
 * - `cancelled`: dropped; units still reserved went back to stock.
 */
export type OrderStatus =
  | "pending"
  | "confirmed"
  | "packed"
  | "shipped"
  | "delivered"
  | "cancelled";

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "pending",
  "confirmed",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
];

/**
 * The statuses each status can move to. `packed` goes straight to
 * `delivered` when the customer picks the order up.
 */
export const ORDER_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped", "delivered", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

/** Derived from confirmed payments against the order's total. */
export type PaymentState = "unpaid" | "partial" | "paid";

export function paymentState(
  paidCents: number,
  totalCents: number,
): PaymentState {
  if (paidCents <= 0) return totalCents === 0 ? "paid" : "unpaid";
  return paidCents >= totalCents ? "paid" : "partial";
}

export type OrderSource = "assistant" | "staff";

export type Order = {
  id: string;
  tenant_id: string;
  number: number;
  customer_id: string;
  channel_account_id: string | null;
  source: OrderSource;
  status: OrderStatus;
  location_id: string | null;
  subtotal_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  notes: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

/** An order in a list, with its buyer and what has been paid. */
export type OrderSummary = Order & {
  customer_name: string;
  customer_phone: string | null;
  paid_cents: number;
  payment_state: PaymentState;
};

export type OrderLine = {
  id: string;
  order_id: string;
  variant_id: string | null;
  sku: string | null;
  name: string;
  unit_price_cents: number;
  quantity: number;
  position: number;
};

export type PaymentStatus = "pending" | "confirmed" | "rejected";

export type Payment = {
  id: string;
  order_id: string;
  payment_method_id: string | null;
  method_name: string;
  amount_cents: number;
  status: PaymentStatus;
  reference: string | null;
  created_by: string | null;
  created_at: number;
  decided_at: number | null;
};

export type Shipment = {
  id: string;
  order_id: string;
  delivery_zone_id: string | null;
  zone_name: string | null;
  recipient_name: string;
  recipient_phone: string | null;
  address_line: string;
  district: string | null;
  city: string | null;
  reference: string | null;
  carrier: string | null;
  tracking_code: string | null;
  shipped_at: number | null;
  delivered_at: number | null;
  created_at: number;
};

/** A shipment in the Envíos list, with its order and buyer. */
export type ShipmentSummary = Shipment & {
  order_number: number;
  order_status: OrderStatus;
  customer_name: string;
  customer_phone: string | null;
  total_cents: number;
  paid_cents: number;
  payment_state: PaymentState;
};

/** One order as its page shows it. */
export type OrderDetail = OrderSummary & {
  customer: Customer;
  lines: OrderLine[];
  payments: Payment[];
  shipment: Shipment | null;
  created_by_name: string | null;
};

export type OrderMetrics = {
  /** Orders by status, every status present. */
  byStatus: Record<OrderStatus, number>;
  /** Totals of delivered orders: all of them, and those placed in the last 30 days. */
  deliveredCents: number;
  deliveredCentsLast30Days: number;
  /** What orders that are not cancelled still owe after confirmed payments. */
  outstandingCents: number;
};
