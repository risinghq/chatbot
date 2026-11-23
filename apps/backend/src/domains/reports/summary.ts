import {
  ASSISTANT_MODELS,
  type AssistantModel,
  MODEL_PRICES,
  type ReportBusiness,
  type ReportSummary,
} from "@vendeya/types";
import { type ExpressionBuilder, sql } from "kysely";
import { db, inOpenTenants, tenantScope } from "../../db/index.ts";
import type { Database } from "../../db/schema.ts";
import { limaDateSql, limaDates, limaDateString } from "../../db/query.ts";
import { OPENAI_API_KEY_SETTING } from "../settings/openai.ts";

const TOP_PRODUCTS = 5;

const limaDate = (column: string) =>
  sql<string>`${sql.raw(limaDateSql(column))}`;
const notCancelled = sql<boolean>`o.status != 'cancelled'`;
const sumWhen = (
  condition: ReturnType<typeof sql>,
  value: ReturnType<typeof sql>,
) =>
  sql<number>`coalesce(sum(case when ${condition} then ${value} else 0 end), 0)`;

/** A null `tenantId` is the platform summary (routes/platform.ts). */
type Range = { tenantId: string | null; startMs: number; endMs: number };

/** One business, or every open one for the platform summary. */
function scoped(tenantId: string | null, column: string) {
  return (eb: ExpressionBuilder<Database, any>) =>
    tenantId ? tenantScope(tenantId, column)(eb) : inOpenTenants(eb, column);
}

/** Conversations a customer wrote to in the range, by business and Lima day when `byDay`. */
function inboundContacts({ tenantId, startMs, endMs }: Range) {
  return db
    .selectFrom("messages as m")
    .innerJoin("conversations as c", (join) =>
      join
        .onRef("c.tenant_id", "=", "m.tenant_id")
        .onRef("c.channel_account_id", "=", "m.channel_account_id")
        .onRef("c.phone_number", "=", "m.phone_number"),
    )
    .where(scoped(tenantId, "m.tenant_id"))
    .where("m.direction", "=", "inbound")
    .where("c.is_simulation", "=", 0)
    .where("m.created_at", ">=", startMs)
    .where("m.created_at", "<=", endMs);
}

const contactCount = sql<number>`count(distinct m.channel_account_id || ':' || m.phone_number)`;

function ordersIn({ tenantId, startMs, endMs }: Range) {
  return db
    .selectFrom("orders as o")
    .where(scoped(tenantId, "o.tenant_id"))
    .where("o.created_at", ">=", startMs)
    .where("o.created_at", "<=", endMs);
}

const isModel = (model: string): model is AssistantModel =>
  (ASSISTANT_MODELS as readonly string[]).includes(model);

/** USD at list price, or null for a model with no known price. */
function costUsd(
  model: string,
  tokensPrompt: number,
  tokensCompletion: number,
): number | null {
  if (!isModel(model)) return null;
  const price = MODEL_PRICES[model];
  return (
    (tokensPrompt * price.inputUsdPerMillion +
      tokensCompletion * price.outputUsdPerMillion) /
    1_000_000
  );
}

/**
 * Contacts, orders, revenue and AI spend over `[startMs, endMs]`. A null
 * `tenantId` spans every open business and adds a line per business.
 */
export async function reportSummary(range: Range): Promise<ReportSummary> {
  const { tenantId, startMs, endMs } = range;

  const [
    contactsByDay,
    contactsByTenant,
    ordersByDay,
    buyersByTenant,
    llmByModel,
    topProducts,
    tenants,
    openAiKeys,
  ] = await Promise.all([
    inboundContacts(range)
      .select([limaDate("m.created_at").as("date"), contactCount.as("n")])
      .groupBy("date")
      .execute(),
    inboundContacts(range)
      .select(["m.tenant_id", contactCount.as("n")])
      .groupBy("m.tenant_id")
      .execute(),
    ordersIn(range)
      .select([
        "o.tenant_id",
        limaDate("o.created_at").as("date"),
        sumWhen(notCancelled, sql`1`).as("orders"),
        sumWhen(sql`o.status = 'cancelled'`, sql`1`).as("cancelled"),
        sumWhen(notCancelled, sql`o.total_cents`).as("revenue"),
        sumWhen(sql`${notCancelled} and o.source = 'assistant'`, sql`1`).as(
          "assistant",
        ),
        sumWhen(
          sql`${notCancelled} and o.source = 'assistant'`,
          sql`o.total_cents`,
        ).as("assistant_revenue"),
      ])
      .groupBy(["o.tenant_id", "date"])
      .execute(),
    ordersIn(range)
      .select([
        "o.tenant_id",
        sql<number>`count(distinct o.customer_id)`.as("n"),
      ])
      .where(notCancelled)
      .groupBy("o.tenant_id")
      .execute(),
    db
      .selectFrom("llm_calls as l")
      .select((eb) => [
        "l.tenant_id",
        "l.model",
        eb.fn.countAll<number>().as("calls"),
        sumWhen(sql`l.status = 'error'`, sql`1`).as("errors"),
        sql<number>`coalesce(sum(l.tokens_prompt), 0)`.as("prompt"),
        sql<number>`coalesce(sum(l.tokens_completion), 0)`.as("completion"),
      ])
      .where(scoped(tenantId, "l.tenant_id"))
      .where("l.created_at", ">=", startMs)
      .where("l.created_at", "<=", endMs)
      .groupBy(["l.tenant_id", "l.model"])
      .execute(),
    db
      .selectFrom("order_lines as ol")
      .innerJoin("orders as o", (join) =>
        join
          .onRef("o.id", "=", "ol.order_id")
          .onRef("o.tenant_id", "=", "ol.tenant_id"),
      )
      .select([
        "ol.name",
        sql<number>`sum(ol.quantity)`.as("quantity"),
        sql<number>`sum(ol.quantity * ol.unit_price_cents)`.as("revenue"),
      ])
      .where(scoped(tenantId, "o.tenant_id"))
      .where(notCancelled)
      .where("o.created_at", ">=", startMs)
      .where("o.created_at", "<=", endMs)
      .groupBy("ol.name")
      .orderBy("revenue", "desc")
      .orderBy("quantity", "desc")
      .limit(TOP_PRODUCTS)
      .execute(),
    tenantId
      ? Promise.resolve([])
      : db
          .selectFrom("tenants")
          .select(["id", "name"])
          .where("status", "=", "active")
          .execute(),
    tenantId
      ? Promise.resolve([])
      : db
          .selectFrom("tenant_secrets")
          .select("tenant_id")
          .where((eb) => inOpenTenants(eb))
          .where("key", "=", OPENAI_API_KEY_SETTING)
          .execute(),
  ]);

  const keyed = new Set(openAiKeys.map((row) => row.tenant_id));
  const businesses = new Map<string, ReportBusiness>(
    tenants.map((tenant) => [
      tenant.id,
      {
        tenantId: tenant.id,
        name: tenant.name,
        contacts: 0,
        orders: 0,
        revenueCents: 0,
        aiCalls: 0,
        aiErrors: 0,
        aiCostUsd: 0,
        hasOpenAiKey: keyed.has(tenant.id),
      },
    ]),
  );

  const days = new Map(
    limaDates(startMs, endMs).map((date) => [
      date,
      { date, contacts: 0, orders: 0, revenueCents: 0 },
    ]),
  );
  for (const row of contactsByDay) {
    const day = days.get(row.date);
    if (day) day.contacts = row.n;
  }

  let contacts = 0;
  for (const row of contactsByTenant) {
    contacts += row.n;
    const business = businesses.get(row.tenant_id);
    if (business) business.contacts = row.n;
  }

  const orders = {
    count: 0,
    cancelled: 0,
    revenueCents: 0,
    averageCents: 0,
    fromAssistant: 0,
    assistantRevenueCents: 0,
    buyers: buyersByTenant.reduce((sum, row) => sum + row.n, 0),
  };
  for (const row of ordersByDay) {
    orders.count += row.orders;
    orders.cancelled += row.cancelled;
    orders.revenueCents += row.revenue;
    orders.fromAssistant += row.assistant;
    orders.assistantRevenueCents += row.assistant_revenue;
    const day = days.get(row.date);
    if (day) {
      day.orders += row.orders;
      day.revenueCents += row.revenue;
    }
    const business = businesses.get(row.tenant_id);
    if (business) {
      business.orders += row.orders;
      business.revenueCents += row.revenue;
    }
  }
  if (orders.count > 0)
    orders.averageCents = Math.round(orders.revenueCents / orders.count);

  const ai = {
    calls: 0,
    errors: 0,
    tokensPrompt: 0,
    tokensCompletion: 0,
    costUsd: 0,
    unpricedCalls: 0,
  };
  for (const row of llmByModel) {
    ai.calls += row.calls;
    ai.errors += row.errors;
    ai.tokensPrompt += row.prompt;
    ai.tokensCompletion += row.completion;
    const cost = costUsd(row.model, row.prompt, row.completion);
    if (cost === null) ai.unpricedCalls += row.calls;
    else ai.costUsd += cost;
    const business = businesses.get(row.tenant_id);
    if (business) {
      business.aiCalls += row.calls;
      business.aiErrors += row.errors;
      business.aiCostUsd += cost ?? 0;
    }
  }

  return {
    startDate: limaDateString(startMs),
    endDate: limaDateString(endMs),
    contacts,
    orders,
    ai,
    days: [...days.values()],
    topProducts: topProducts.map((row) => ({
      name: row.name,
      quantity: row.quantity,
      revenueCents: row.revenue,
    })),
    businesses: tenantId
      ? null
      : [...businesses.values()].sort(
          (a, b) =>
            b.revenueCents - a.revenueCents ||
            b.contacts - a.contacts ||
            a.name.localeCompare(b.name),
        ),
  };
}
