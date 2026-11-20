import type { DeliveryZone, PaymentMethod } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { db } from "../../db/index.ts";
import { isConstraintError } from "../../db/constraints.ts";

/** A create or rename to a name the business already uses. */
export class DuplicateNameError extends Error {
  constructor(readonly taken: string) {
    super(`The name ${taken} is already used`);
  }
}

type ZoneFields = Pick<DeliveryZone, "name" | "fee_cents" | "is_active">;
type MethodFields = Pick<PaymentMethod, "name" | "instructions" | "is_active">;

function parseName(
  body: Record<string, unknown>,
  partial: boolean,
): string | undefined | Error {
  if (body.name === undefined && partial) return undefined;
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return new Error("name must be a non-empty string");
  }
  return body.name.trim();
}

function parseActive(body: Record<string, unknown>): 0 | 1 | undefined | Error {
  if (body.is_active === undefined) return undefined;
  if (typeof body.is_active !== "boolean") {
    return new Error("is_active must be a boolean");
  }
  return body.is_active ? 1 : 0;
}

/** The fields of a zone create or update, or the reason the body is refused. */
export function parseZoneFields(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<ZoneFields> | string {
  const fields: Partial<ZoneFields> = {};
  const name = parseName(body, partial);
  if (name instanceof Error) return name.message;
  if (name !== undefined) fields.name = name;

  if (body.fee_cents !== undefined || !partial) {
    const fee = body.fee_cents;
    if (typeof fee !== "number" || !Number.isSafeInteger(fee) || fee < 0) {
      return "fee_cents must be a whole number of 0 or more";
    }
    fields.fee_cents = fee;
  }

  const active = parseActive(body);
  if (active instanceof Error) return active.message;
  if (active !== undefined) fields.is_active = active;
  return fields;
}

/** The fields of a payment method create or update, or the reason the body is refused. */
export function parseMethodFields(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<MethodFields> | string {
  const fields: Partial<MethodFields> = {};
  const name = parseName(body, partial);
  if (name instanceof Error) return name.message;
  if (name !== undefined) fields.name = name;

  if (body.instructions !== undefined) {
    if (body.instructions !== null && typeof body.instructions !== "string") {
      return "instructions must be a string or null";
    }
    fields.instructions = body.instructions?.trim() || null;
  }

  const active = parseActive(body);
  if (active instanceof Error) return active.message;
  if (active !== undefined) fields.is_active = active;
  return fields;
}

async function uniqueName<T>(name: string | undefined, write: Promise<T>) {
  try {
    return await write;
  } catch (error) {
    if (name && isConstraintError(error, "UNIQUE")) {
      throw new DuplicateNameError(name);
    }
    throw error;
  }
}

/** Where a business delivers and what each place costs. */
export const DeliveryZoneService = {
  list: async (tenantId: string): Promise<DeliveryZone[]> =>
    await db
      .selectFrom("delivery_zones")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .orderBy("name")
      .execute(),

  get: async (tenantId: string, id: string): Promise<DeliveryZone | null> =>
    (await db
      .selectFrom("delivery_zones")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst()) ?? null,

  /** Throws `DuplicateNameError`. */
  create: async (
    tenantId: string,
    fields: Pick<ZoneFields, "name" | "fee_cents"> & Partial<ZoneFields>,
  ): Promise<DeliveryZone> => {
    const id = newId();
    await uniqueName(
      fields.name,
      db
        .insertInto("delivery_zones")
        .values({ id, tenant_id: tenantId, ...fields })
        .execute(),
    );
    return (await DeliveryZoneService.get(tenantId, id))!;
  },

  /** Null when the zone does not exist. Throws `DuplicateNameError`. */
  update: async (
    tenantId: string,
    id: string,
    fields: Partial<ZoneFields>,
  ): Promise<DeliveryZone | null> => {
    if (Object.keys(fields).length > 0) {
      await uniqueName(
        fields.name,
        db
          .updateTable("delivery_zones")
          .set(fields)
          .where("tenant_id", "=", tenantId)
          .where("id", "=", id)
          .execute(),
      );
    }
    return await DeliveryZoneService.get(tenantId, id);
  },

  /** A shipment keeps the zone's name and fee after the zone is deleted. */
  delete: async (tenantId: string, id: string): Promise<boolean> => {
    const result = await db
      .deleteFrom("delivery_zones")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  },
};

/** How a business takes payment, and what the customer is told to do. */
export const PaymentMethodService = {
  list: async (tenantId: string): Promise<PaymentMethod[]> =>
    await db
      .selectFrom("payment_methods")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .orderBy("name")
      .execute(),

  get: async (tenantId: string, id: string): Promise<PaymentMethod | null> =>
    (await db
      .selectFrom("payment_methods")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst()) ?? null,

  /** Throws `DuplicateNameError`. */
  create: async (
    tenantId: string,
    fields: Pick<MethodFields, "name"> & Partial<MethodFields>,
  ): Promise<PaymentMethod> => {
    const id = newId();
    await uniqueName(
      fields.name,
      db
        .insertInto("payment_methods")
        .values({ id, tenant_id: tenantId, ...fields })
        .execute(),
    );
    return (await PaymentMethodService.get(tenantId, id))!;
  },

  /** Null when the method does not exist. Throws `DuplicateNameError`. */
  update: async (
    tenantId: string,
    id: string,
    fields: Partial<MethodFields>,
  ): Promise<PaymentMethod | null> => {
    if (Object.keys(fields).length > 0) {
      await uniqueName(
        fields.name,
        db
          .updateTable("payment_methods")
          .set(fields)
          .where("tenant_id", "=", tenantId)
          .where("id", "=", id)
          .execute(),
      );
    }
    return await PaymentMethodService.get(tenantId, id);
  },

  /** A payment keeps the method's name after the method is deleted. */
  delete: async (tenantId: string, id: string): Promise<boolean> => {
    const result = await db
      .deleteFrom("payment_methods")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  },
};
