import {
  DOCUMENT_TYPES,
  type Customer,
  type CustomerAddress,
  type CustomerSummary,
  type DocumentType,
} from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { db, tenantScope } from "../../db/index.ts";
import { isConstraintError } from "../../db/constraints.ts";

export type CustomerFields = Pick<
  Customer,
  "name" | "phone" | "email" | "document_type" | "document_number" | "notes"
>;

export type AddressFields = Pick<
  CustomerAddress,
  "line" | "district" | "city" | "reference"
>;

/** A write that gives a customer the phone of another customer of the business. */
export class DuplicatePhoneError extends Error {
  constructor(readonly phone: string) {
    super(`Another customer already has the phone ${phone}`);
  }
}

/** A delete of a customer that has orders, which keep their buyer. */
export class CustomerHasOrdersError extends Error {
  constructor() {
    super("A customer with orders cannot be deleted");
  }
}

/** A Peruvian mobile as people write it: nine digits starting with 9. */
const PERU_MOBILE = /^9\d{8}$/;

/**
 * A phone as WhatsApp sends it: digits with the country code. Spaces, dashes,
 * parentheses and a leading `+` are dropped, and a Peruvian mobile written
 * without its country code gains 51, so it matches the customer's
 * conversation. Null when nothing is left.
 */
export function normalizePhone(value: string): string | null {
  const digits = value.replace(/[\s\-()+.]/g, "");
  if (digits === "") return null;
  return PERU_MOBILE.test(digits) ? `51${digits}` : digits;
}

function optionalText(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined | Error {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string")
    return new Error(`${key} must be a string or null`);
  return value.trim() || null;
}

/**
 * The fields of a create (`partial` false) or an update (`partial` true), or
 * the reason the body is refused. A document is a type and a number together.
 */
export function parseCustomerFields(
  body: Record<string, unknown>,
  partial: boolean,
): Partial<CustomerFields> | string {
  const fields: Partial<CustomerFields> = {};

  if (body.name !== undefined || !partial) {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return "name must be a non-empty string";
    }
    fields.name = body.name.trim();
  }

  for (const key of ["email", "notes"] as const) {
    const value = optionalText(body, key);
    if (value instanceof Error) return value.message;
    if (value !== undefined) fields[key] = value;
  }

  const phone = optionalText(body, "phone");
  if (phone instanceof Error) return phone.message;
  if (phone !== undefined) {
    const normalized = phone === null ? null : normalizePhone(phone);
    if (normalized !== null && !/^\d{6,15}$/.test(normalized)) {
      return "phone must be 6 to 15 digits, with the country code";
    }
    fields.phone = normalized;
  }

  if (body.document_type !== undefined || body.document_number !== undefined) {
    const type = body.document_type ?? null;
    const number = optionalText(body, "document_number");
    if (number instanceof Error) return number.message;
    if (type !== null && !DOCUMENT_TYPES.includes(type as DocumentType)) {
      return `document_type must be one of ${DOCUMENT_TYPES.join(", ")}`;
    }
    if ((type === null) !== (number == null)) {
      return "document_type and document_number go together";
    }
    fields.document_type = type as DocumentType | null;
    fields.document_number = number ?? null;
  }

  return fields;
}

/** The fields of a new address, or the reason the body is refused. */
export function parseAddressFields(
  body: Record<string, unknown>,
): AddressFields | string {
  if (typeof body.line !== "string" || body.line.trim() === "") {
    return "line must be a non-empty string";
  }
  const fields: AddressFields = {
    line: body.line.trim(),
    district: null,
    city: null,
    reference: null,
  };
  for (const key of ["district", "city", "reference"] as const) {
    const value = optionalText(body, key);
    if (value instanceof Error) return value.message;
    fields[key] = value ?? null;
  }
  return fields;
}

function withUniquePhone<T>(phone: string | null | undefined) {
  return async (write: Promise<T>): Promise<T> => {
    try {
      return await write;
    } catch (error) {
      if (phone && isConstraintError(error, "UNIQUE")) {
        throw new DuplicatePhoneError(phone);
      }
      throw error;
    }
  };
}

export const CustomerService = {
  /** Newest first. `search` matches part of the name or the phone. */
  list: async (
    tenantId: string,
    options: { search?: string; limit: number; offset: number },
  ): Promise<CustomerSummary[]> => {
    const search = options.search?.trim();
    return (await db
      .selectFrom("customers as c")
      .selectAll("c")
      .select((eb) => [
        eb
          .selectFrom("orders as o")
          .select(eb.fn.countAll<number>().as("n"))
          .whereRef("o.customer_id", "=", "c.id")
          .whereRef("o.tenant_id", "=", "c.tenant_id")
          .as("order_count"),
        eb
          .selectFrom("orders as o")
          .select((sub) =>
            sub.fn
              .coalesce(sub.fn.sum<number>("o.total_cents"), sub.lit(0))
              .as("s"),
          )
          .whereRef("o.customer_id", "=", "c.id")
          .whereRef("o.tenant_id", "=", "c.tenant_id")
          .where("o.status", "!=", "cancelled")
          .as("spent_cents"),
      ])
      .where(tenantScope(tenantId, "c.tenant_id"))
      .$if(Boolean(search), (q) =>
        q.where((eb) =>
          eb.or([
            eb("c.name", "like", `%${search}%`),
            eb("c.phone", "like", `%${search}%`),
          ]),
        ),
      )
      .orderBy("c.id", "desc")
      .limit(options.limit)
      .offset(options.offset)
      .execute()) as CustomerSummary[];
  },

  get: async (tenantId: string, id: string): Promise<Customer | null> =>
    (await db
      .selectFrom("customers")
      .selectAll()
      .where("id", "=", id)
      .where(tenantScope(tenantId))
      .executeTakeFirst()) ?? null,

  getByPhone: async (
    tenantId: string,
    phone: string,
  ): Promise<Customer | null> =>
    (await db
      .selectFrom("customers")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("phone", "=", phone)
      .executeTakeFirst()) ?? null,

  /** Throws `DuplicatePhoneError` when another customer has the phone. */
  create: async (
    tenantId: string,
    fields: CustomerFields,
  ): Promise<Customer> => {
    const id = newId();
    await withUniquePhone(fields.phone)(
      db
        .insertInto("customers")
        .values({ id, tenant_id: tenantId, ...fields })
        .execute(),
    );
    return (await CustomerService.get(tenantId, id))!;
  },

  /**
   * The customer with this phone, created with `name` when the business has
   * none. One insert that ignores a taken phone, so two concurrent orders from
   * one number make one customer. An existing customer keeps its name; a
   * document fills one the customer lacks.
   */
  upsertByPhone: async (
    tenantId: string,
    input: {
      phone: string;
      name: string;
      document?: { type: DocumentType; number: string } | null;
    },
  ): Promise<Customer> => {
    await db
      .insertInto("customers")
      .orIgnore()
      .values({
        id: newId(),
        tenant_id: tenantId,
        name: input.name,
        phone: input.phone,
        document_type: input.document?.type ?? null,
        document_number: input.document?.number ?? null,
      })
      .execute();

    if (input.document) {
      await db
        .updateTable("customers")
        .set({
          document_type: input.document.type,
          document_number: input.document.number,
          updated_at: Date.now(),
        })
        .where("tenant_id", "=", tenantId)
        .where("phone", "=", input.phone)
        .where("document_type", "is", null)
        .execute();
    }

    return (await CustomerService.getByPhone(tenantId, input.phone))!;
  },

  /** Null when the customer does not exist. Throws `DuplicatePhoneError`. */
  update: async (
    tenantId: string,
    id: string,
    fields: Partial<CustomerFields>,
  ): Promise<Customer | null> => {
    if (Object.keys(fields).length > 0) {
      await withUniquePhone(fields.phone)(
        db
          .updateTable("customers")
          .set({ ...fields, updated_at: Date.now() })
          .where("id", "=", id)
          .where("tenant_id", "=", tenantId)
          .execute(),
      );
    }
    return await CustomerService.get(tenantId, id);
  },

  /**
   * False when the customer does not exist. Throws `CustomerHasOrdersError`:
   * the orders' foreign key refuses the delete.
   */
  delete: async (tenantId: string, id: string): Promise<boolean> => {
    try {
      const result = await db
        .deleteFrom("customers")
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    } catch (error) {
      if (isConstraintError(error, "FOREIGN KEY")) {
        throw new CustomerHasOrdersError();
      }
      throw error;
    }
  },

  addresses: async (
    tenantId: string,
    customerId: string,
  ): Promise<CustomerAddress[]> =>
    await db
      .selectFrom("customer_addresses")
      .select([
        "id",
        "customer_id",
        "line",
        "district",
        "city",
        "reference",
        "created_at",
      ])
      .where("tenant_id", "=", tenantId)
      .where("customer_id", "=", customerId)
      .orderBy("id")
      .execute(),

  /** The caller has checked that the customer belongs to the tenant. */
  addAddress: async (
    tenantId: string,
    customerId: string,
    fields: AddressFields,
  ): Promise<CustomerAddress> => {
    const id = newId();
    await db
      .insertInto("customer_addresses")
      .values({ id, tenant_id: tenantId, customer_id: customerId, ...fields })
      .execute();
    return await db
      .selectFrom("customer_addresses")
      .select([
        "id",
        "customer_id",
        "line",
        "district",
        "city",
        "reference",
        "created_at",
      ])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  },

  deleteAddress: async (
    tenantId: string,
    customerId: string,
    id: string,
  ): Promise<boolean> => {
    const result = await db
      .deleteFrom("customer_addresses")
      .where("id", "=", id)
      .where("customer_id", "=", customerId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  },
};
