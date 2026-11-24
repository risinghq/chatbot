import type { ExpressionBuilder } from "kysely";
import type { ReminderSettings } from "@vendeya/types";
import { DEFAULT_REMINDER_SETTINGS } from "@vendeya/types";
import type { Database } from "../../db/schema.ts";
import { db, inOpenTenants, tenantScope } from "../../db/index.ts";
import { publicOrigin } from "../../config.ts";
import { ChannelAccountService } from "../channels/accounts.ts";
import { createLogger } from "../../lib/logger.ts";
import { enqueueTemplate } from "./send.ts";
import { TemplateService } from "./templates.ts";

const logger = createLogger("reminders");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Eb = ExpressionBuilder<Database, any>;

/** The customer's newest inbound message, or 0 when they never wrote. */
const lastInbound = (eb: Eb, tenantId: string) =>
  eb.fn.coalesce(
    eb
      .selectFrom("messages as m")
      .select((e) => e.fn.max("m.created_at").as("last"))
      .whereRef("m.phone_number", "=", "cu.phone")
      .where("m.tenant_id", "=", tenantId)
      .where("m.direction", "=", "inbound"),
    eb.val(0),
  );

/**
 * Phones a marketing send may not reach: opted out, or already sent a
 * marketing message inside `capCutoff`. Skipping them in SQL keeps a
 * permanently-blocked customer out of the limited due set.
 */
const marketingAllowed = (eb: Eb, tenantId: string, capCutoff: number) =>
  eb.and([
    eb.not(
      eb.exists(
        eb
          .selectFrom("marketing_opt_outs as mo")
          .select("mo.phone_number")
          .whereRef("mo.phone_number", "=", "cu.phone")
          .where("mo.tenant_id", "=", tenantId),
      ),
    ),
    eb.not(
      eb.exists(
        eb
          .selectFrom("marketing_sends as ms")
          .select("ms.sent_at")
          .whereRef("ms.phone_number", "=", "cu.phone")
          .where("ms.tenant_id", "=", tenantId)
          .where("ms.sent_at", ">=", capCutoff),
      ),
    ),
  ]);

const KEYS = {
  cart_enabled: "reminder_cart_enabled",
  cart_hours: "reminder_cart_hours",
  cart_template: "reminder_cart_template_id",
  inactive_enabled: "reminder_inactive_enabled",
  inactive_days: "reminder_inactive_days",
  inactive_template: "reminder_inactive_template_id",
  marketing_interval: "marketing_min_interval_days",
} as const;

async function settingsMap(tenantId: string): Promise<Record<string, string>> {
  const rows = await db
    .selectFrom("tenant_settings")
    .select(["key", "value"])
    .where(tenantScope(tenantId))
    .where("key", "in", Object.values(KEYS))
    .execute();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getReminderSettings(
  tenantId: string,
): Promise<ReminderSettings> {
  const s = await settingsMap(tenantId);
  const num = (v: string | undefined, dflt: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : dflt;
  };
  return {
    abandoned_cart: {
      enabled: s[KEYS.cart_enabled] === "1",
      hours: num(
        s[KEYS.cart_hours],
        DEFAULT_REMINDER_SETTINGS.abandoned_cart.hours,
      ),
      template_id: s[KEYS.cart_template] ?? null,
    },
    inactive: {
      enabled: s[KEYS.inactive_enabled] === "1",
      days: num(s[KEYS.inactive_days], DEFAULT_REMINDER_SETTINGS.inactive.days),
      template_id: s[KEYS.inactive_template] ?? null,
    },
    marketing_min_interval_days: num(
      s[KEYS.marketing_interval],
      DEFAULT_REMINDER_SETTINGS.marketing_min_interval_days,
    ),
  };
}

export async function saveReminderSettings(
  tenantId: string,
  settings: ReminderSettings,
): Promise<void> {
  const now = Date.now();
  const entries: [string, string][] = [
    [KEYS.cart_enabled, settings.abandoned_cart.enabled ? "1" : "0"],
    [KEYS.cart_hours, String(settings.abandoned_cart.hours)],
    [KEYS.cart_template, settings.abandoned_cart.template_id ?? ""],
    [KEYS.inactive_enabled, settings.inactive.enabled ? "1" : "0"],
    [KEYS.inactive_days, String(settings.inactive.days)],
    [KEYS.inactive_template, settings.inactive.template_id ?? ""],
    [KEYS.marketing_interval, String(settings.marketing_min_interval_days)],
  ];
  for (const [key, value] of entries) {
    await db
      .insertInto("tenant_settings")
      .values({ tenant_id: tenantId, key, value, updated_at: now })
      .onConflict((oc) =>
        oc
          .columns(["tenant_id", "key"])
          .doUpdateSet({ value, updated_at: now }),
      )
      .execute();
  }
}

/** The order's open TAYPI pay link, or null when it has none. */
async function payLinkFor(tenantId: string, orderId: string, now: number) {
  const charge = await db
    .selectFrom("taypi_charges")
    .select("id")
    .where(tenantScope(tenantId))
    .where("order_id", "=", orderId)
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return charge ? `${publicOrigin()}/pagar/${charge.id}` : null;
}

function formatCents(cents: number): string {
  return `S/ ${(cents / 100).toFixed(2)}`;
}

async function sendReminder(
  tenantId: string,
  templateId: string,
  phone: string,
  ctx: Parameters<typeof enqueueTemplate>[3],
  now: number,
  marketingIntervalDays: number,
): Promise<boolean> {
  const template = await TemplateService.get(tenantId, templateId);
  if (template?.status !== "approved") {
    logger.warn(
      { tenantId, templateId },
      "Reminder template is not approved; nothing sent",
    );
    return false;
  }
  const account = await ChannelAccountService.getDefaultForTenant(tenantId);
  if (!account) return false;
  const sent = await enqueueTemplate(
    { tenantId, channelAccountId: account.id, phoneNumber: phone },
    template,
    template.params,
    ctx,
    now,
    template.category === "marketing" ? marketingIntervalDays : null,
  );
  return sent !== "opted_out" && sent !== "capped";
}

/**
 * The orders due a cart reminder: pending, unpaid, at least `hours` old, with
 * the customer silent for that long and no reminder sent yet.
 */
async function dueCartOrders(
  tenantId: string,
  hours: number,
  now: number,
  marketingDays: number | null,
) {
  const cutoff = now - hours * HOUR_MS;
  return db
    .selectFrom("orders as o")
    .innerJoin("customers as cu", (j) =>
      j
        .onRef("cu.id", "=", "o.customer_id")
        .onRef("cu.tenant_id", "=", "o.tenant_id"),
    )
    .select(["o.id", "o.number", "o.total_cents", "cu.name", "cu.phone"])
    .where("o.tenant_id", "=", tenantId)
    .where("o.status", "=", "pending")
    .where("o.created_at", "<=", cutoff)
    .where("o.cart_reminder_sent_at", "is", null)
    .where("cu.phone", "is not", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("payments as p")
            .select("p.id")
            .whereRef("p.order_id", "=", "o.id")
            .where("p.tenant_id", "=", tenantId)
            .where("p.status", "=", "confirmed"),
        ),
      ),
    )
    .where((eb) => eb(lastInbound(eb, tenantId), "<=", cutoff))
    .$if(marketingDays !== null, (qb) =>
      qb.where((eb) =>
        marketingAllowed(eb, tenantId, now - (marketingDays ?? 0) * DAY_MS),
      ),
    )
    .limit(50)
    .execute();
}

/**
 * The customers due an inactive reminder: their newest delivered order and
 * their newest inbound message are both older than `days`, and they were not
 * reminded since that last activity — one message per inactive spell.
 */
async function dueInactiveCustomers(
  tenantId: string,
  days: number,
  now: number,
  marketingDays: number | null,
) {
  const cutoff = now - days * DAY_MS;
  const lastOrder = (eb: Eb) =>
    eb.fn.coalesce(
      eb
        .selectFrom("orders as o")
        .select((e) => e.fn.max("o.updated_at").as("last"))
        .whereRef("o.customer_id", "=", "cu.id")
        .where("o.tenant_id", "=", tenantId)
        .where("o.status", "=", "delivered"),
      eb.val(0),
    );
  return db
    .selectFrom("customers as cu")
    .select(["cu.id", "cu.name", "cu.phone", "cu.inactive_reminder_sent_at"])
    .where("cu.tenant_id", "=", tenantId)
    .where("cu.phone", "is not", null)
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
    .where((eb) => eb(lastOrder(eb), "<=", cutoff))
    .where((eb) => eb(lastInbound(eb, tenantId), "<=", cutoff))
    .where((eb) =>
      eb.or([
        eb("cu.inactive_reminder_sent_at", "is", null),
        eb.and([
          eb("cu.inactive_reminder_sent_at", "is not", null),
          eb.or([
            eb(lastOrder(eb), ">", eb.ref("cu.inactive_reminder_sent_at")),
            eb(
              lastInbound(eb, tenantId),
              ">",
              eb.ref("cu.inactive_reminder_sent_at"),
            ),
          ]),
        ]),
      ]),
    )
    .$if(marketingDays !== null, (qb) =>
      qb.where((eb) =>
        marketingAllowed(eb, tenantId, now - (marketingDays ?? 0) * DAY_MS),
      ),
    )
    .limit(50)
    .execute();
}

/**
 * One pass of the standing reminders for every open tenant that has them on.
 * Runs from the minute sweep; each send is one outbox row the conversation's
 * object delivers, and a stamped column keeps each to one send.
 */
export async function runReminders(now: number): Promise<void> {
  const tenants = await db
    .selectFrom("tenant_settings")
    .select("tenant_id")
    .distinct()
    .where("key", "in", [KEYS.cart_enabled, KEYS.inactive_enabled])
    .where("value", "=", "1")
    .where(inOpenTenants)
    .execute();

  for (const { tenant_id: tenantId } of tenants) {
    try {
      const settings = await getReminderSettings(tenantId);

      if (
        settings.abandoned_cart.enabled &&
        settings.abandoned_cart.template_id
      ) {
        const template = await TemplateService.get(
          tenantId,
          settings.abandoned_cart.template_id,
        );
        const marketingDays =
          template?.category === "marketing"
            ? settings.marketing_min_interval_days
            : null;
        for (const order of await dueCartOrders(
          tenantId,
          settings.abandoned_cart.hours,
          now,
          marketingDays,
        )) {
          const sent = await sendReminder(
            tenantId,
            settings.abandoned_cart.template_id,
            order.phone!,
            {
              customer_name: order.name,
              order_number: `#${order.number}`,
              order_total: formatCents(order.total_cents),
              pay_link: await payLinkFor(tenantId, order.id, now),
            },
            now,
            settings.marketing_min_interval_days,
          );
          if (sent) {
            await db
              .updateTable("orders")
              .set({ cart_reminder_sent_at: now })
              .where(tenantScope(tenantId))
              .where("id", "=", order.id)
              .execute();
          }
        }
      }

      if (settings.inactive.enabled && settings.inactive.template_id) {
        const template = await TemplateService.get(
          tenantId,
          settings.inactive.template_id,
        );
        const marketingDays =
          template?.category === "marketing"
            ? settings.marketing_min_interval_days
            : null;
        for (const customer of await dueInactiveCustomers(
          tenantId,
          settings.inactive.days,
          now,
          marketingDays,
        )) {
          const sent = await sendReminder(
            tenantId,
            settings.inactive.template_id,
            customer.phone!,
            { customer_name: customer.name },
            now,
            settings.marketing_min_interval_days,
          );
          if (sent) {
            await db
              .updateTable("customers")
              .set({ inactive_reminder_sent_at: now })
              .where(tenantScope(tenantId))
              .where("id", "=", customer.id)
              .execute();
          }
        }
      }
    } catch (error) {
      logger.error({ error, tenantId }, "Reminder pass failed");
    }
  }
}
