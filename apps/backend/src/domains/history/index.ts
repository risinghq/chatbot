import type { Selectable } from "kysely";
import type {
  HistoryActor,
  HistoryEntry,
  HistorySubject,
} from "@vendeya/types";
import { db, tenantScope, withoutTenantScope } from "../../db/index.ts";
import type { AuditLogTable } from "../../db/schema.ts";

type AuditRow = Selectable<AuditLogTable>;

export type HistoryPage = { limit: number; offset: number };

/** One business's history, newest first. */
export async function businessHistory(
  tenantId: string,
  page: HistoryPage,
): Promise<HistoryEntry[]> {
  const rows = await db
    .selectFrom("audit_log")
    .selectAll()
    .where(tenantScope(tenantId))
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return entries(rows, tenantId);
}

/**
 * The actions taken outside any business, newest first: platform settings,
 * a token made with no business, an account made from the terminal.
 */
export async function platformHistory(
  page: HistoryPage,
): Promise<HistoryEntry[]> {
  const rows = await withoutTenantScope("platform rows have no tenant")
    .selectFrom("audit_log")
    .selectAll()
    .where("tenant_id", "is", null)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(page.limit)
    .offset(page.offset)
    .execute();
  return entries(rows, null);
}

async function entries(
  rows: AuditRow[],
  tenantId: string | null,
): Promise<HistoryEntry[]> {
  const [actors, subjects] = await Promise.all([
    actorNames(rows),
    subjectLabels(rows, tenantId),
  ]);
  return rows.map((row) => {
    const details = parseDetails(row.metadata);
    return {
      id: row.id,
      at: row.created_at,
      actor: actorOf(row, actors),
      action: row.action,
      subject: subjectOf(row, subjects, details),
      details,
    };
  });
}

function parseDetails(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  const value: unknown = JSON.parse(metadata);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actorOf(row: AuditRow, names: Map<string, string>): HistoryActor {
  if (row.user_id === null) {
    return { kind: "terminal", name: row.actor.replace(/^cli:/, "") };
  }
  return {
    kind: "user",
    userId: row.user_id,
    name: names.get(row.user_id) || null,
  };
}

async function actorNames(rows: AuditRow[]): Promise<Map<string, string>> {
  const ids = unique(rows.map((row) => row.user_id));
  return userNames(ids);
}

async function userNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await withoutTenantScope("users are global, keyed by id")
    .selectFrom("users")
    .select(["id", "name"])
    .where("id", "in", ids)
    .execute();
  return new Map(users.map((u) => [u.id, u.name]));
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

const key = (type: string, id: string) => `${type}:${id}`;

/**
 * The subject a row names when its record is gone: the name the row recorded,
 * or no label. An API token keeps no row after it is revoked, so its subject
 * always comes from the recorded name.
 */
function subjectOf(
  row: AuditRow,
  resolved: Map<string, HistorySubject>,
  details: Record<string, unknown>,
): HistorySubject | null {
  if (row.resource_id === null) return null;
  const found = resolved.get(key(row.resource_type, row.resource_id));
  if (found) return found;
  const recorded = details.name;
  return {
    type: row.resource_type,
    id: row.resource_id,
    label: typeof recorded === "string" && recorded ? recorded : null,
  };
}

/**
 * Looks up the people-facing name of every subject on the page, one query per
 * kind. A business's records are read in that business only, so a row naming
 * another business's id resolves to nothing.
 */
async function subjectLabels(
  rows: AuditRow[],
  tenantId: string | null,
): Promise<Map<string, HistorySubject>> {
  const idsOf = (type: string) =>
    unique(
      rows
        .filter((row) => row.resource_type === type)
        .map((row) => row.resource_id),
    );
  const found = new Map<string, HistorySubject>();
  const add = (type: string, id: string, subject: HistorySubject) =>
    found.set(key(type, id), subject);

  const global = [
    (async () => {
      for (const [id, name] of await userNames(idsOf("user"))) {
        add("user", id, { type: "user", id, label: name || null });
      }
    })(),
    (async () => {
      const ids = idsOf("tenant");
      if (ids.length === 0) return;
      const tenants = await withoutTenantScope("tenants are keyed by id")
        .selectFrom("tenants")
        .select(["id", "name"])
        .where("id", "in", ids)
        .execute();
      for (const t of tenants) {
        add("tenant", t.id, { type: "tenant", id: t.id, label: t.name });
      }
    })(),
  ];
  if (tenantId === null) {
    await Promise.all(global);
    return found;
  }

  const scope = tenantScope(tenantId);
  const named = async (
    type: string,
    table:
      | "customers"
      | "products"
      | "stock_locations"
      | "delivery_zones"
      | "payment_methods",
  ) => {
    const ids = idsOf(type);
    if (ids.length === 0) return;
    const records = await db
      .selectFrom(table)
      .select(["id", "name"])
      .where(scope)
      .where("id", "in", ids)
      .execute();
    for (const r of records) add(type, r.id, { type, id: r.id, label: r.name });
  };

  await Promise.all([
    ...global,
    named("customer", "customers"),
    named("product", "products"),
    named("stock_location", "stock_locations"),
    named("delivery_zone", "delivery_zones"),
    named("payment_method", "payment_methods"),
    (async () => {
      const ids = idsOf("order");
      if (ids.length === 0) return;
      const orders = await db
        .selectFrom("orders")
        .select(["id", "number"])
        .where(scope)
        .where("id", "in", ids)
        .execute();
      for (const o of orders) {
        add("order", o.id, { type: "order", id: o.id, label: `#${o.number}` });
      }
    })(),
    (async () => {
      // A conversation is keyed by the customer's phone.
      const phones = idsOf("conversation");
      if (phones.length === 0) return;
      const customers = await db
        .selectFrom("customers")
        .select(["phone", "name"])
        .where(scope)
        .where("phone", "in", phones)
        .execute();
      const names = new Map(customers.map((c) => [c.phone, c.name]));
      for (const phone of phones) {
        add("conversation", phone, {
          type: "conversation",
          id: phone,
          label: names.get(phone) ?? `+${phone}`,
        });
      }
    })(),
    (async () => {
      const ids = idsOf("channel_account");
      if (ids.length === 0) return;
      const accounts = await db
        .selectFrom("channel_accounts")
        .select(["id", "label", "display_phone_number", "phone_number_id"])
        .where(scope)
        .where("id", "in", ids)
        .execute();
      for (const a of accounts) {
        add("channel_account", a.id, {
          type: "channel_account",
          id: a.id,
          label: a.label || a.display_phone_number || a.phone_number_id,
        });
      }
    })(),
    (async () => {
      const ids = idsOf("invitation");
      if (ids.length === 0) return;
      const invitations = await db
        .selectFrom("invitations")
        .select(["id", "email"])
        .where(scope)
        .where("id", "in", ids)
        .execute();
      for (const i of invitations) {
        add("invitation", i.id, {
          type: "invitation",
          id: i.id,
          label: i.email,
        });
      }
    })(),
    variantProducts(
      tenantId,
      idsOf("product_variant"),
      idsOf("stock_movement"),
      add,
    ),
  ]);
  return found;
}

/**
 * A variant, and a stock movement through its variant, are named by their
 * product, since the product's page is where both are seen.
 */
async function variantProducts(
  tenantId: string,
  variantIds: string[],
  movementIds: string[],
  add: (type: string, id: string, subject: HistorySubject) => void,
): Promise<void> {
  const scope = tenantScope(tenantId);
  const movements = movementIds.length
    ? await db
        .selectFrom("stock_movements")
        .select(["id", "variant_id"])
        .where(scope)
        .where("id", "in", movementIds)
        .execute()
    : [];
  const ids = unique([...variantIds, ...movements.map((m) => m.variant_id)]);
  if (ids.length === 0) return;

  const variants = await db
    .selectFrom("product_variants")
    .select(["id", "product_id", "name"])
    .where(scope)
    .where("id", "in", ids)
    .execute();
  const productIds = unique(variants.map((v) => v.product_id));
  const products = productIds.length
    ? await db
        .selectFrom("products")
        .select(["id", "name"])
        .where(scope)
        .where("id", "in", productIds)
        .execute()
    : [];
  const productName = new Map(products.map((p) => [p.id, p.name]));

  const variantSubject = new Map<string, HistorySubject>();
  for (const v of variants) {
    const product = productName.get(v.product_id) ?? null;
    variantSubject.set(v.id, {
      type: "product",
      id: v.product_id,
      label: product && v.name ? `${product} · ${v.name}` : product,
    });
  }
  for (const id of variantIds) {
    const subject = variantSubject.get(id);
    if (subject) add("product_variant", id, subject);
  }
  for (const m of movements) {
    const subject = variantSubject.get(m.variant_id);
    if (subject) add("stock_movement", m.id, subject);
  }
}
