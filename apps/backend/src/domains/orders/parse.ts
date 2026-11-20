import {
  DOCUMENT_TYPES,
  type DocumentType,
  type Shipment,
} from "@vendeya/types";
import { normalizePhone } from "../customers/index.ts";
import type { FreeLine, ShipmentInput, VariantLine } from "./write.ts";

/** Who an order is for: a known customer, or one found or made by phone. */
export type CustomerRef =
  | { id: string }
  | {
      phone: string;
      name: string;
      document: { type: DocumentType; number: string } | null;
    };

export type OrderBody = {
  customer: CustomerRef;
  channelAccountId: string | null;
  lines: (VariantLine | FreeLine)[];
  locationId: string | null;
  shipment: ShipmentInput | null;
  notes: string | null;
};

export type PaymentBody = {
  methodId: string | null;
  methodName: string | null;
  amountCents: number;
  reference: string | null;
};

type ShipmentFields = Partial<
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
>;

class BodyError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new BodyError(`${key} must be a string or null`);
  }
  return value.trim() || null;
}

function requiredText(body: Record<string, unknown>, key: string): string {
  const value = text(body, key);
  if (value === null) throw new BodyError(`${key} must be a non-empty string`);
  return value;
}

function cents(value: unknown, key: string, min: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min
  ) {
    throw new BodyError(`${key} must be a whole number of ${min} or more`);
  }
  return value;
}

function parseCustomer(body: Record<string, unknown>): CustomerRef {
  if (typeof body.customer_id === "string" && body.customer_id) {
    return { id: body.customer_id };
  }
  if (!isObject(body.customer)) {
    throw new BodyError("an order needs customer_id or customer");
  }
  const customer = body.customer;
  const phone = normalizePhone(requiredText(customer, "phone"));
  if (phone === null || !/^\d{6,15}$/.test(phone)) {
    throw new BodyError(
      "customer.phone must be 6 to 15 digits, with the country code",
    );
  }
  const type = text(customer, "document_type");
  const number = text(customer, "document_number");
  if ((type === null) !== (number === null)) {
    throw new BodyError("document_type and document_number go together");
  }
  if (type !== null && !DOCUMENT_TYPES.includes(type as DocumentType)) {
    throw new BodyError(
      `document_type must be one of ${DOCUMENT_TYPES.join(", ")}`,
    );
  }
  return {
    phone,
    name: requiredText(customer, "name"),
    document:
      type === null ? null : { type: type as DocumentType, number: number! },
  };
}

function parseLine(line: unknown, index: number): VariantLine | FreeLine {
  if (!isObject(line)) throw new BodyError(`lines[${index}] must be an object`);
  const quantity = cents(line.quantity, `lines[${index}].quantity`, 1);
  const price =
    line.unit_price_cents === undefined || line.unit_price_cents === null
      ? undefined
      : cents(line.unit_price_cents, `lines[${index}].unit_price_cents`, 0);

  if (typeof line.variant_id === "string" && line.variant_id) {
    return { variantId: line.variant_id, quantity, unitPriceCents: price };
  }
  if (price === undefined) {
    throw new BodyError(
      `lines[${index}] needs variant_id, or a name and unit_price_cents`,
    );
  }
  return {
    name: requiredText(line, "name"),
    sku: text(line, "sku"),
    quantity,
    unitPriceCents: price,
  };
}

function parseShipment(value: unknown): ShipmentInput | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value))
    throw new BodyError("shipment must be an object or null");
  return {
    zoneId: text(value, "zone_id"),
    feeCents:
      value.fee_cents === undefined
        ? undefined
        : cents(value.fee_cents, "shipment.fee_cents", 0),
    recipientName: text(value, "recipient_name"),
    recipientPhone: text(value, "recipient_phone"),
    addressLine: requiredText(value, "address_line"),
    district: text(value, "district"),
    city: text(value, "city"),
    reference: text(value, "reference"),
  };
}

function refusal<T>(parse: () => T): T | string {
  try {
    return parse();
  } catch (error) {
    if (error instanceof BodyError) return error.message;
    throw error;
  }
}

/** A new order from a request body, or the reason the body is refused. */
export function parseOrderBody(
  body: Record<string, unknown>,
): OrderBody | string {
  return refusal(() => {
    if (!Array.isArray(body.lines))
      throw new BodyError("lines must be an array");
    return {
      customer: parseCustomer(body),
      channelAccountId: text(body, "channel_account_id"),
      lines: body.lines.map(parseLine),
      locationId: text(body, "location_id"),
      shipment: parseShipment(body.shipment),
      notes: text(body, "notes"),
    };
  });
}

/** A payment from a request body, or the reason the body is refused. */
export function parsePaymentBody(
  body: Record<string, unknown>,
): PaymentBody | string {
  return refusal(() => ({
    methodId: text(body, "method_id"),
    methodName: text(body, "method_name"),
    amountCents: cents(body.amount_cents, "amount_cents", 1),
    reference: text(body, "reference"),
  }));
}

const SHIPMENT_KEYS = [
  "carrier",
  "tracking_code",
  "recipient_name",
  "recipient_phone",
  "address_line",
  "district",
  "city",
  "reference",
] as const;

/** The shipment fields a request sets, or the reason the body is refused. */
export function parseShipmentFields(
  body: Record<string, unknown>,
): ShipmentFields | string {
  return refusal(() => {
    const fields: Record<string, string | null> = {};
    for (const key of SHIPMENT_KEYS) {
      if (body[key] === undefined) continue;
      fields[key] =
        key === "address_line" ? requiredText(body, key) : text(body, key);
    }
    return fields as ShipmentFields;
  });
}
