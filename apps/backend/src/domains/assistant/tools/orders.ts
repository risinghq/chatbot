import { DOCUMENT_TYPES, type DocumentType } from "@vendeya/types";
import { db } from "../../../db/index.ts";
import {
  CustomerService,
  parseAddressFields,
  type AddressFields,
} from "../../customers/index.ts";
import {
  DeliveryZoneService,
  OrderReads,
  OrderWrites,
  PaymentMethodService,
} from "../../orders/index.ts";
import {
  TAYPI_ASSISTANT_METHOD,
  TaypiCharges,
  payLink,
} from "../../payments/charges.ts";
import {
  TAYPI_MAX_CENTS,
  TaypiError,
  taypiKeys,
} from "../../payments/taypi.ts";
import { StockService } from "../../stock/index.ts";
import {
  lines as parseLines,
  optionalText,
  soles,
  text,
  type LineArg,
} from "./args.ts";
import { assistantLocation } from "./catalog.ts";
import {
  answer,
  ToolArgumentError,
  type Tool,
  type ToolContext,
} from "./types.ts";

const LINES_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      variant_id: { type: "string" },
      quantity: { type: "integer" },
    },
    required: ["variant_id", "quantity"],
    additionalProperties: false,
  },
};

const NULLABLE_TEXT = { type: ["string", "null"] };

type Priced = {
  lines: {
    variant_id: string;
    name: string;
    quantity: number;
    unit_price_cents: number;
    available: number;
  }[];
  zone: { id: string; name: string; fee_cents: number } | null;
};

/**
 * The lines at catalog price with the units available where the assistant
 * sells, and the zone. Throws `ToolArgumentError` for a variant or zone the
 * business does not sell.
 */
async function price(
  tenantId: string,
  lineArgs: LineArg[],
  zoneId: string | null,
): Promise<Priced> {
  const ids = lineArgs.map((l) => l.variantId);
  const variants = await db
    .selectFrom("product_variants as v")
    .innerJoin("products as p", (join) =>
      join
        .onRef("p.id", "=", "v.product_id")
        .onRef("p.tenant_id", "=", "v.tenant_id"),
    )
    .select(["v.id", "v.product_id"])
    .where("v.tenant_id", "=", tenantId)
    .where("v.id", "in", ids)
    .where("v.is_active", "=", 1)
    .where("p.status", "=", "active")
    .execute();
  const location = await assistantLocation(tenantId);
  const stock = await StockService.levels(tenantId, location, [
    ...new Set(variants.map((v) => v.product_id)),
  ]);
  const byId = new Map(stock.map((s) => [s.variant_id, s]));
  const priced = lineArgs.map((line) => {
    const row = byId.get(line.variantId);
    if (!row || !variants.some((v) => v.id === line.variantId)) {
      throw new ToolArgumentError(`variant ${line.variantId} is not for sale`);
    }
    return {
      variant_id: row.variant_id,
      name: row.variant_name
        ? `${row.product_name} · ${row.variant_name}`
        : row.product_name,
      quantity: line.quantity,
      unit_price_cents: row.price_cents,
      available: Math.max(0, row.available),
    };
  });

  let zone: Priced["zone"] = null;
  if (zoneId) {
    const found = await DeliveryZoneService.get(tenantId, zoneId);
    if (!found?.is_active)
      throw new ToolArgumentError("delivery zone not found");
    zone = { id: found.id, name: found.name, fee_cents: found.fee_cents };
  }
  return { lines: priced, zone };
}

/** The priced order as the model reads it. */
function summary(priced: Priced) {
  const subtotal = priced.lines.reduce(
    (sum, l) => sum + l.unit_price_cents * l.quantity,
    0,
  );
  const fee = priced.zone?.fee_cents ?? 0;
  return {
    lines: priced.lines.map((l) => ({
      variant_id: l.variant_id,
      name: l.name,
      quantity: l.quantity,
      unit_price: soles(l.unit_price_cents),
      line_total: soles(l.unit_price_cents * l.quantity),
      enough_stock: l.available >= l.quantity,
    })),
    delivery_zone: priced.zone?.name ?? null,
    delivery_fee: soles(fee),
    total: soles(subtotal + fee),
  };
}

const quote: Tool = {
  name: "quote",
  description:
    "Price a cart before the customer confirms it: each line at catalog " +
    "price and whether stock covers it, the delivery fee of the zone, and " +
    "the total. Pass zone_id null for a pickup.",
  parameters: {
    type: "object",
    properties: { lines: LINES_SCHEMA, zone_id: NULLABLE_TEXT },
    required: ["lines", "zone_id"],
    additionalProperties: false,
  },
  run: async (ctx, args) =>
    answer(
      summary(
        await price(
          ctx.tenantId,
          parseLines(args),
          optionalText(args, "zone_id"),
        ),
      ),
    ),
};

function documentArg(
  args: Record<string, unknown>,
): { type: DocumentType; number: string } | null {
  const type = optionalText(args, "document_type");
  const number = optionalText(args, "document_number");
  if (!type && !number) return null;
  if (!type || !number) {
    throw new ToolArgumentError(
      "give both document_type and document_number, or neither",
    );
  }
  if (!DOCUMENT_TYPES.includes(type as DocumentType)) {
    throw new ToolArgumentError(
      `document_type must be one of ${DOCUMENT_TYPES.join(", ")}`,
    );
  }
  return { type: type as DocumentType, number };
}

function addressArg(args: Record<string, unknown>): AddressFields | null {
  const value = args.address;
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") {
    throw new ToolArgumentError("address must be an object or null");
  }
  const fields = parseAddressFields(value as Record<string, unknown>);
  if (typeof fields === "string")
    throw new ToolArgumentError(`address: ${fields}`);
  return fields;
}

function sameAddress(a: AddressFields, b: AddressFields): boolean {
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  return (
    norm(a.line) === norm(b.line) &&
    norm(a.district) === norm(b.district) &&
    norm(a.city) === norm(b.city)
  );
}

/** Keeps a new address on the customer, so the next order can offer it. */
async function rememberAddress(
  tenantId: string,
  customerId: string,
  address: AddressFields,
): Promise<void> {
  const saved = await CustomerService.addresses(tenantId, customerId);
  if (saved.some((a) => sameAddress(a, address))) return;
  await CustomerService.addAddress(tenantId, customerId, address);
}

/**
 * What the assistant tells the customer to pay a filed order by TAYPI: the
 * pay link, or why there is none so it offers another method.
 */
async function taypiInstructions(
  tenantId: string,
  orderId: string,
): Promise<string> {
  const other =
    "Ofrece otro medio de pago de list_payment_methods; el pedido ya está creado.";
  try {
    const opened = await TaypiCharges.open(tenantId, orderId);
    if ("charge" in opened) {
      return (
        `Envía al cliente este link para pagar ${soles(opened.charge.amount_cents)}: ` +
        `${payLink(opened.charge.id)} . Vence en 1 hora. El pago se confirma solo.`
      );
    }
    if (opened.refused === "above_maximum") {
      return `TAYPI cobra hasta ${soles(TAYPI_MAX_CENTS)} por pago. ${other}`;
    }
    return `No se pudo crear el link de pago. ${other}`;
  } catch (error) {
    if (!(error instanceof TaypiError)) throw error;
    return `TAYPI no respondió. ${other}`;
  }
}

const createOrder: Tool = {
  name: "create_order",
  description:
    "File the order once the customer confirmed the products, quantities, " +
    "delivery and payment. Saves the customer by this chat's phone. Pass " +
    "address null for a pickup; a delivery needs zone_id when the business " +
    "has zones. Stock is held for the order and staff confirm it.",
  parameters: {
    type: "object",
    properties: {
      customer_name: { type: "string" },
      document_type: {
        type: ["string", "null"],
        enum: [...DOCUMENT_TYPES, null],
      },
      document_number: NULLABLE_TEXT,
      lines: LINES_SCHEMA,
      address: {
        type: ["object", "null"],
        properties: {
          line: { type: "string" },
          district: NULLABLE_TEXT,
          city: NULLABLE_TEXT,
          reference: NULLABLE_TEXT,
        },
        required: ["line", "district", "city", "reference"],
        additionalProperties: false,
      },
      zone_id: NULLABLE_TEXT,
      payment_method_id: NULLABLE_TEXT,
      notes: NULLABLE_TEXT,
    },
    required: [
      "customer_name",
      "document_type",
      "document_number",
      "lines",
      "address",
      "zone_id",
      "payment_method_id",
      "notes",
    ],
    additionalProperties: false,
  },
  run: async (ctx, args) => {
    const name = text(args, "customer_name");
    const document = documentArg(args);
    const address = addressArg(args);
    const zoneId = optionalText(args, "zone_id");
    const methodId = optionalText(args, "payment_method_id");
    const notes = optionalText(args, "notes");

    if (address && !zoneId) {
      const zones = await DeliveryZoneService.list(ctx.tenantId);
      if (zones.some((z) => z.is_active)) {
        throw new ToolArgumentError(
          "a delivery needs zone_id: call list_delivery_zones",
        );
      }
    }
    if (!address && zoneId) {
      throw new ToolArgumentError(
        "zone_id needs an address; pass null for a pickup",
      );
    }
    const location = await assistantLocation(ctx.tenantId);
    if (!location) {
      return answer({
        error:
          "the business sells from several stock locations and has not set " +
          "one for the assistant: hand the order off to staff",
      });
    }
    const priced = await price(ctx.tenantId, parseLines(args), zoneId);
    const viaTaypi = methodId === TAYPI_ASSISTANT_METHOD.id;
    if (viaTaypi && !(await taypiKeys(ctx.tenantId))) {
      throw new ToolArgumentError("payment method not found");
    }
    const method = viaTaypi
      ? { ...TAYPI_ASSISTANT_METHOD, is_active: true }
      : methodId
        ? await PaymentMethodService.get(ctx.tenantId, methodId)
        : null;
    if (methodId && !method?.is_active) {
      throw new ToolArgumentError("payment method not found");
    }

    if (ctx.simulated) {
      const short = priced.lines.find((l) => l.available < l.quantity);
      if (short) {
        return answer({ error: `not enough stock of ${short.name}` });
      }
      return answer({
        simulated: true,
        note: "A simulation files no order. This is the order it would file.",
        customer_name: name,
        payment_method: method?.name ?? null,
        ...summary(priced),
      });
    }

    const customer = await CustomerService.upsertByPhone(ctx.tenantId, {
      phone: ctx.phone,
      name,
      document,
    });
    const created = await OrderWrites.create({
      tenantId: ctx.tenantId,
      customer: { id: customer.id, name: customer.name, phone: customer.phone },
      channelAccountId: ctx.channelAccountId,
      source: "assistant",
      createdBy: null,
      notes,
      locationId: location,
      lines: priced.lines.map((l) => ({
        variantId: l.variant_id,
        quantity: l.quantity,
      })),
      shipment: address
        ? {
            zoneId,
            recipientName: customer.name,
            recipientPhone: ctx.phone,
            addressLine: address.line,
            district: address.district,
            city: address.city,
            reference: address.reference,
          }
        : null,
    });
    if (address) await rememberAddress(ctx.tenantId, customer.id, address);
    if (method && !viaTaypi) {
      await OrderWrites.addPayment(
        ctx.tenantId,
        created.id,
        { methodId: method.id, amountCents: created.total_cents },
        null,
      );
    }
    const instructions = viaTaypi
      ? await taypiInstructions(ctx.tenantId, created.id)
      : (method?.instructions ?? null);
    const order =
      (await OrderReads.detail(ctx.tenantId, created.id)) ?? created;
    return answer(
      {
        order_number: order.number,
        status: order.status,
        payment_method: method?.name ?? null,
        payment_instructions: instructions,
        ...summary(priced),
        total: soles(order.total_cents),
      },
      [{ kind: "order_created", order }],
    );
  },
};

const handOff: Tool = {
  name: "hand_off",
  description:
    "Pass the chat to staff: the customer asks for a person, is upset, or " +
    "asks what you cannot answer from the tools and the business's notes. " +
    "Tell the customer someone will write soon.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string" } },
    required: ["reason"],
    additionalProperties: false,
  },
  run: async (_ctx: ToolContext, args) => {
    const reason = text(args, "reason");
    return answer({ handed_off: true }, [{ kind: "hand_off", reason }]);
  },
};

export const orderTools = [quote, createOrder, handOff];
