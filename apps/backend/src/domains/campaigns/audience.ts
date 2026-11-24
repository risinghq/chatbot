import type { Audience } from "@vendeya/types";
import { AUDIENCE_KINDS } from "@vendeya/types";
import { db, tenantScope } from "../../db/index.ts";
import { normalizePhone } from "../customers/index.ts";

export type AudienceTarget = {
  customer_id: string | null;
  phone_number: string;
};

/** The body an audience-count or create request sends, or the refusal. */
export function parseAudience(value: unknown): Audience | string {
  if (typeof value !== "object" || value === null) return "audience required";
  const { kind } = value as { kind?: unknown };
  if (typeof kind !== "string" || !AUDIENCE_KINDS.includes(kind as never)) {
    return `audience.kind must be one of ${AUDIENCE_KINDS.join(", ")}`;
  }
  switch (kind) {
    case "all":
      return { kind };
    case "category": {
      const category = (value as { category?: unknown }).category;
      if (typeof category !== "string" || !category.trim()) {
        return "audience.category must be a category name";
      }
      return { kind, category: category.trim() };
    }
    case "product": {
      const productId = (value as { product_id?: unknown }).product_id;
      if (typeof productId !== "string" || !productId) {
        return "audience.product_id required";
      }
      return { kind, product_id: productId };
    }
    case "inactive": {
      const days = Number((value as { days?: unknown }).days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return "audience.days must be a whole number from 1 to 3650";
      }
      return { kind, days };
    }
    case "phones": {
      const phones = (value as { phones?: unknown }).phones;
      if (!Array.isArray(phones) || phones.length === 0) {
        return "audience.phones must be a non-empty list";
      }
      const normalized = [
        ...new Set(
          phones
            .map((p) => (typeof p === "string" ? normalizePhone(p) : null))
            .filter((p): p is string => p !== null),
        ),
      ];
      if (normalized.length === 0) return "audience.phones held no valid phone";
      if (normalized.length > 10_000) return "audience.phones is over 10,000";
      return { kind, phones: normalized };
    }
  }
  return "audience.kind is not supported";
}

/**
 * The customers a campaign goes out to. `phones` names contacts who may hold
 * no customer row; the other kinds read the business's customers.
 */
export async function resolveAudience(
  tenantId: string,
  audience: Audience,
  now: number,
): Promise<AudienceTarget[]> {
  switch (audience.kind) {
    case "phones":
      // Pasted lists keep whatever punctuation they were copied with.
      return [
        ...new Set(
          audience.phones
            .map((phone) => normalizePhone(phone))
            .filter((p): p is string => p !== null),
        ),
      ].map((phone) => ({ customer_id: null, phone_number: phone }));

    case "all": {
      const rows = await db
        .selectFrom("customers")
        .select(["id", "phone"])
        .where(tenantScope(tenantId))
        .where("phone", "is not", null)
        .execute();
      return rows.map((r) => ({ customer_id: r.id, phone_number: r.phone! }));
    }

    case "category":
    case "product": {
      const rows = await db
        .selectFrom("orders as o")
        .innerJoin("order_lines as l", (j) =>
          j
            .onRef("l.order_id", "=", "o.id")
            .onRef("l.tenant_id", "=", "o.tenant_id"),
        )
        .innerJoin("product_variants as v", (j) =>
          j
            .onRef("v.id", "=", "l.variant_id")
            .onRef("v.tenant_id", "=", "l.tenant_id"),
        )
        .innerJoin("products as p", (j) =>
          j
            .onRef("p.id", "=", "v.product_id")
            .onRef("p.tenant_id", "=", "v.tenant_id"),
        )
        .innerJoin("customers as cu", (j) =>
          j
            .onRef("cu.id", "=", "o.customer_id")
            .onRef("cu.tenant_id", "=", "o.tenant_id"),
        )
        .select(["cu.id", "cu.phone"])
        .distinct()
        .where("o.tenant_id", "=", tenantId)
        .where("cu.phone", "is not", null)
        .$if(audience.kind === "category", (q) =>
          q.where(
            "p.category",
            "=",
            (audience as { category: string }).category,
          ),
        )
        .$if(audience.kind === "product", (q) =>
          q.where("p.id", "=", (audience as { product_id: string }).product_id),
        )
        .execute();
      return rows.map((r) => ({ customer_id: r.id, phone_number: r.phone! }));
    }

    case "inactive": {
      const cutoff = now - audience.days * 24 * 60 * 60 * 1000;
      const rows = await db
        .selectFrom("customers as cu")
        .select(["cu.id", "cu.phone"])
        .where("cu.tenant_id", "=", tenantId)
        .where("cu.phone", "is not", null)
        // The customer's last activity is their newest delivered order or
        // inbound message; nothing since `cutoff` makes them inactive.
        .where((eb) =>
          eb(
            eb.fn.coalesce(
              eb
                .selectFrom("orders as o")
                .select((eb2) => eb2.fn.max("o.updated_at").as("last"))
                .whereRef("o.customer_id", "=", "cu.id")
                .where("o.tenant_id", "=", tenantId)
                .where("o.status", "=", "delivered"),
              eb.val(0),
            ),
            "<=",
            cutoff,
          ),
        )
        .where((eb) =>
          eb(
            eb.fn.coalesce(
              eb
                .selectFrom("messages as m")
                .select((eb2) => eb2.fn.max("m.created_at").as("last"))
                .whereRef("m.phone_number", "=", "cu.phone")
                .where("m.tenant_id", "=", tenantId)
                .where("m.direction", "=", "inbound"),
              eb.val(0),
            ),
            "<=",
            cutoff,
          ),
        )
        // Only customers who ever bought: inactivity means a past order.
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("orders as o")
              .select("o.id")
              .whereRef("o.customer_id", "=", "cu.id")
              .where("o.tenant_id", "=", tenantId)
              .where("o.status", "=", "delivered"),
          ),
        )
        .execute();
      return rows.map((r) => ({ customer_id: r.id, phone_number: r.phone! }));
    }
  }
}
