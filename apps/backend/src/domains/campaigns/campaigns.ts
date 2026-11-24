import type {
  Audience,
  Campaign,
  CampaignResults,
  CampaignSummary,
  ParamBinding,
} from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { db, inOpenTenants, tenantScope } from "../../db/index.ts";
import { ChannelAccountService } from "../channels/accounts.ts";
import { createLogger } from "../../lib/logger.ts";
import { resolveAudience, type AudienceTarget } from "./audience.ts";
import { enqueueTemplate } from "./send.ts";
import { TemplateService } from "./templates.ts";

const logger = createLogger("campaigns");

/** Recipients settled per dispatch pass; a bigger campaign drains over sweeps. */
const DISPATCH_BUDGET = 200;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Orders are credited to a campaign for a week after its send. */
export const ATTRIBUTION_DAYS = 7;

function rowToCampaign(row: Record<string, unknown>): Campaign {
  return {
    ...row,
    audience: JSON.parse(row.audience as string),
    params: JSON.parse((row.params as string) ?? "[]"),
  } as Campaign;
}

async function results(
  tenantId: string,
  campaign: Campaign,
): Promise<CampaignResults> {
  const rows = await db
    .selectFrom("campaign_recipients as r")
    .select(["r.status", "r.replied_at", "r.message_id"])
    .where("r.tenant_id", "=", tenantId)
    .where("r.campaign_id", "=", campaign.id)
    .execute();

  const messageIds = rows
    .map((r) => r.message_id)
    .filter((id): id is string => id !== null);
  const sent = new Map(
    messageIds.length === 0
      ? []
      : (
          await db
            .selectFrom("messages")
            .select(["id", "status"])
            .where("tenant_id", "=", tenantId)
            .where("id", "in", messageIds)
            .where("whatsapp_message_id", "is not", null)
            .execute()
        ).map((m) => [m.id, m.status]),
  );

  const empty: CampaignResults = {
    targeted: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    skipped: 0,
    replied: 0,
    orders: 0,
    orders_total_cents: 0,
  };
  for (const r of rows) {
    empty.targeted++;
    // Meta accepted the send when the messages row carries its id.
    const accepted = r.message_id !== null && sent.has(r.message_id);
    if (accepted || ["sent", "delivered", "read"].includes(r.status))
      empty.sent++;
    if (r.status === "delivered" || r.status === "read") empty.delivered++;
    if (r.status === "read") empty.read++;
    if (r.status === "failed" || sent.get(r.message_id!) === "failed")
      empty.failed++;
    if (r.status === "skipped") empty.skipped++;
    if (r.replied_at !== null) empty.replied++;
  }

  if (campaign.sent_at !== null) {
    const order = await db
      .selectFrom("orders as o")
      .select([
        (eb) => eb.fn.countAll().as("n"),
        (eb) =>
          eb.fn.coalesce(eb.fn.sum("o.total_cents"), eb.val(0)).as("total"),
      ])
      .where("o.tenant_id", "=", tenantId)
      .where("o.created_at", ">=", campaign.sent_at)
      .where("o.created_at", "<=", campaign.sent_at + ATTRIBUTION_DAYS * DAY_MS)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("campaign_recipients as r")
            .select("r.id")
            .whereRef("r.customer_id", "=", "o.customer_id")
            .where("r.tenant_id", "=", tenantId)
            .where("r.campaign_id", "=", campaign.id)
            .where("r.status", "<>", "skipped"),
        ),
      )
      .executeTakeFirst();
    empty.orders = Number(order?.n ?? 0);
    empty.orders_total_cents = Number(order?.total ?? 0);
  }
  return empty;
}

export const CampaignService = {
  async list(tenantId: string): Promise<CampaignSummary[]> {
    const rows = await db
      .selectFrom("campaigns as c")
      .leftJoin("message_templates as t", (j) =>
        j
          .onRef("t.id", "=", "c.template_id")
          .onRef("t.tenant_id", "=", "c.tenant_id"),
      )
      .selectAll("c")
      .select("t.name as template_name")
      .where("c.tenant_id", "=", tenantId)
      .orderBy("c.created_at", "desc")
      .limit(200)
      .execute();
    return Promise.all(
      rows.map(async (r) => {
        const campaign = rowToCampaign(r);
        return {
          ...campaign,
          template_name: r.template_name ?? undefined,
          results: await results(tenantId, campaign),
        };
      }),
    );
  },

  async get(tenantId: string, id: string): Promise<CampaignSummary | null> {
    const row = await db
      .selectFrom("campaigns as c")
      .leftJoin("message_templates as t", (j) =>
        j
          .onRef("t.id", "=", "c.template_id")
          .onRef("t.tenant_id", "=", "c.tenant_id"),
      )
      .selectAll("c")
      .select("t.name as template_name")
      .where("c.tenant_id", "=", tenantId)
      .where("c.id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    const campaign = rowToCampaign(row);
    return {
      ...campaign,
      template_name: row.template_name ?? undefined,
      results: await results(tenantId, campaign),
    };
  },

  async create(
    tenantId: string,
    fields: {
      name: string;
      template_id: string;
      audience: Audience;
      params?: ParamBinding[];
      scheduled_at?: number | null;
    },
    userId: string | null,
  ): Promise<Campaign | { error: string; status?: number }> {
    const template = await TemplateService.get(tenantId, fields.template_id);
    if (!template) return { error: "template_not_found", status: 404 };
    if (template.status !== "approved") {
      return { error: "template_not_approved" };
    }
    const account = await ChannelAccountService.getDefaultForTenant(tenantId);
    if (!account) return { error: "no_channel_account" };

    const id = newId();
    const now = Date.now();
    await db
      .insertInto("campaigns")
      .values({
        id,
        tenant_id: tenantId,
        name: fields.name,
        template_id: fields.template_id,
        audience: JSON.stringify(fields.audience),
        params: JSON.stringify(fields.params ?? template.params),
        status: "scheduled",
        scheduled_at: fields.scheduled_at ?? now,
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return (await this.get(tenantId, id))!;
  },

  async cancel(tenantId: string, id: string): Promise<boolean> {
    const changed = await db
      .updateTable("campaigns")
      .set({ status: "cancelled", updated_at: Date.now() })
      .where(tenantScope(tenantId))
      .where("id", "=", id)
      .where("status", "=", "scheduled")
      .executeTakeFirst();
    return changed.numUpdatedRows === 1n;
  },
};

/**
 * Sends a due campaign: materializes its audience once, then queues each
 * pending recipient's template send on the outbox inside the consent rules.
 * The sweep calls it for every campaign whose time came.
 */
export async function dispatchCampaign(
  campaignId: string,
  tenantId: string,
  now: number,
): Promise<void> {
  const row = await db
    .selectFrom("campaigns")
    .selectAll()
    .where(tenantScope(tenantId))
    .where("id", "=", campaignId)
    .where("status", "in", ["scheduled", "sending"])
    .executeTakeFirst();
  if (!row) return;
  const campaign = rowToCampaign(row);

  const template = await TemplateService.get(tenantId, campaign.template_id);
  if (template?.status !== "approved") {
    await db
      .updateTable("campaigns")
      .set({
        status: "failed",
        failure_reason: "template_not_approved",
        updated_at: now,
      })
      .where(tenantScope(tenantId))
      .where("id", "=", campaignId)
      .execute();
    return;
  }

  const account = await ChannelAccountService.getDefaultForTenant(tenantId);
  if (!account) {
    await db
      .updateTable("campaigns")
      .set({
        status: "failed",
        failure_reason: "no_channel_account",
        updated_at: now,
      })
      .where(tenantScope(tenantId))
      .where("id", "=", campaignId)
      .execute();
    return;
  }

  if (campaign.status === "scheduled") {
    const targets = await resolveAudience(tenantId, campaign.audience, now);
    await db
      .insertInto("campaign_recipients")
      .values(
        targets.map((t: AudienceTarget) => ({
          id: newId(),
          tenant_id: tenantId,
          campaign_id: campaignId,
          customer_id: t.customer_id,
          phone_number: t.phone_number,
          created_at: now,
        })),
      )
      .onConflict((oc) =>
        oc.columns(["campaign_id", "phone_number"]).doNothing(),
      )
      .execute();
    await db
      .updateTable("campaigns")
      .set({ status: "sending", updated_at: now })
      .where(tenantScope(tenantId))
      .where("id", "=", campaignId)
      .execute();
  }

  const marketing = template.category === "marketing";
  const intervalDays = marketing ? await marketingIntervalDays(tenantId) : 0;
  const pending = await db
    .selectFrom("campaign_recipients")
    .selectAll()
    .where(tenantScope(tenantId))
    .where("campaign_id", "=", campaignId)
    .where("status", "=", "pending")
    .orderBy("created_at")
    .limit(DISPATCH_BUDGET)
    .execute();

  for (const r of pending) {
    const customer = r.customer_id
      ? await db
          .selectFrom("customers")
          .select("name")
          .where(tenantScope(tenantId))
          .where("id", "=", r.customer_id)
          .executeTakeFirst()
      : undefined;

    const messageId = await enqueueTemplate(
      { tenantId, channelAccountId: account.id, phoneNumber: r.phone_number },
      template,
      campaign.params,
      { customer_name: customer?.name ?? null },
      now,
      marketing ? intervalDays : null,
      r.id,
    );
    if (messageId === "opted_out" || messageId === "capped") {
      await db
        .updateTable("campaign_recipients")
        .set({ status: "skipped", skip_reason: messageId })
        .where(tenantScope(tenantId))
        .where("id", "=", r.id)
        .execute();
    }
  }

  const remaining = await db
    .selectFrom("campaign_recipients")
    .select((eb) => eb.fn.countAll().as("n"))
    .where(tenantScope(tenantId))
    .where("campaign_id", "=", campaignId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (Number(remaining?.n ?? 0) === 0) {
    await db
      .updateTable("campaigns")
      .set({ status: "sent", sent_at: now, updated_at: now })
      .where(tenantScope(tenantId))
      .where("id", "=", campaignId)
      .execute();
  }
}

/** The per-business marketing cap, in days (default 7). */
export async function marketingIntervalDays(tenantId: string): Promise<number> {
  const row = await db
    .selectFrom("tenant_settings")
    .select("value")
    .where(tenantScope(tenantId))
    .where("key", "=", "marketing_min_interval_days")
    .executeTakeFirst();
  const days = Number(row?.value);
  return Number.isFinite(days) && days >= 1 ? days : 7;
}

/** The campaigns whose send time came, over every open tenant. */
export async function dispatchDueCampaigns(now: number): Promise<void> {
  const due = await db
    .selectFrom("campaigns")
    .select(["id", "tenant_id"])
    .where("status", "in", ["scheduled", "sending"])
    .where((eb) =>
      eb.or([eb("scheduled_at", "<=", now), eb("status", "=", "sending")]),
    )
    .where(inOpenTenants)
    .limit(20)
    .execute();
  for (const c of due) {
    try {
      await dispatchCampaign(c.id, c.tenant_id, now);
    } catch (error) {
      logger.error(
        { error, campaignId: c.id, tenantId: c.tenant_id },
        "Campaign dispatch failed",
      );
    }
  }
}
