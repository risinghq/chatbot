import { beforeEach, describe, expect, it } from "vitest";
import { parseIncomingMessage } from "../src/adapters/whatsapp/parsers/index.ts";
import { reportSummary } from "../src/domains/reports/summary.ts";
import { OrderWrites } from "../src/domains/orders/index.ts";
import { getOne } from "./helpers/db.ts";
import {
  createTenantFixture,
  fileOrder,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { backendFetch } from "./helpers/turn.ts";
import { inboundMessage, signedWebhookRequest } from "./helpers/webhook.ts";

const CUSTOMER = "51987000111";
const DAY_MS = 24 * 60 * 60 * 1000;

let tenant: TenantFixture;

beforeEach(async () => {
  tenant = await createTenantFixture("ad-tenant");
});

/** A Meta text message with a click-to-WhatsApp `referral`, as the API sends it. */
function adMessage(
  from: string,
  text: string,
  referral: Record<string, unknown> | null,
  options: { id?: string; sentAt?: number } = {},
) {
  return {
    from,
    id: options.id ?? `wamid-${crypto.randomUUID()}`,
    timestamp: String(Math.floor((options.sentAt ?? Date.now()) / 1000)),
    type: "text",
    text: { body: text },
    ...(referral && { referral }),
  };
}

const AD = {
  source_type: "ad",
  source_id: "120226000000000001",
  source_url: "https://fb.me/abc",
  headline: "50% de descuento en zapatillas",
  body: "Solo esta semana",
  media_type: "image",
  ctwa_clid: "ctwa-clid-1",
};

const SECOND_AD = {
  source_type: "ad",
  source_id: "120226000000000002",
  headline: "Envío gratis hoy",
  ctwa_clid: "ctwa-clid-2",
};

async function deliverAd(
  referral: Record<string, unknown>,
  options: { id?: string; sentAt?: number; from?: string } = {},
) {
  const body = inboundMessage(
    tenant.phoneNumberId,
    adMessage(options.from ?? CUSTOMER, "hola, vi el anuncio", referral, {
      ...options,
      sentAt: options.sentAt ?? Date.now() - 11 * 60 * 1000,
    }),
  );
  return backendFetch("/api/webhook", await signedWebhookRequest(body));
}

function conversationRow(phone = CUSTOMER) {
  return getOne<{
    ad_source_id: string | null;
    ad_headline: string | null;
    ad_ctwa_clid: string | null;
    ad_received_at: number | null;
  }>(
    `SELECT ad_source_id, ad_headline, ad_ctwa_clid, ad_received_at
       FROM conversations
      WHERE tenant_id = ? AND phone_number = ?`,
    [tenant.tenantId, phone],
  );
}

describe("parsing a referral", () => {
  it("reads the ad from a real-shaped webhook message", () => {
    const message = parseIncomingMessage(
      adMessage(CUSTOMER, "hola", AD, { sentAt: 1700000000000 }),
    );
    expect(message.referral).toEqual({
      sourceId: "120226000000000001",
      headline: "50% de descuento en zapatillas",
      ctwaClid: "ctwa-clid-1",
    });
  });

  it("leaves messages without an ad referral as before", () => {
    expect(
      parseIncomingMessage(adMessage(CUSTOMER, "hola", null)).referral,
    ).toBeUndefined();
    expect(
      parseIncomingMessage(
        adMessage(CUSTOMER, "hola", {
          source_type: "post",
          source_id: "post-1",
        }),
      ).referral,
    ).toBeUndefined();
    expect(
      parseIncomingMessage(adMessage(CUSTOMER, "hola", { source_type: "ad" }))
        .referral,
    ).toBeUndefined();
  });
});

describe("the conversation's ad", () => {
  it("records the referral the message carried, with its own time", async () => {
    const sentAt = Date.now() - 11 * 60 * 1000;
    expect((await deliverAd(AD, { sentAt })).status).toBe(200);

    const row = await conversationRow();
    expect(row).toEqual({
      ad_source_id: AD.source_id,
      ad_headline: AD.headline,
      ad_ctwa_clid: AD.ctwa_clid,
      ad_received_at: Math.floor(sentAt / 1000) * 1000,
    });
  });

  it("replaces the ad on a later click and keeps it on a plain message", async () => {
    await deliverAd(AD);
    await deliverAd(SECOND_AD, { sentAt: Date.now() });

    const row = await conversationRow();
    expect(row?.ad_source_id).toBe(SECOND_AD.source_id);
    expect(row?.ad_headline).toBe(SECOND_AD.headline);

    const plain = inboundMessage(
      tenant.phoneNumberId,
      adMessage(CUSTOMER, "otra duda", null),
    );
    await backendFetch("/api/webhook", await signedWebhookRequest(plain));
    expect((await conversationRow())?.ad_source_id).toBe(SECOND_AD.source_id);
  });

  it("keeps the newer ad when Meta delivers an older click after it", async () => {
    const newerAt = Date.now() - 5 * 60 * 1000;
    const olderAt = Date.now() - 60 * 60 * 1000;
    await deliverAd(SECOND_AD, { sentAt: newerAt });
    await deliverAd(AD, { sentAt: olderAt });

    const row = await conversationRow();
    expect(row?.ad_source_id).toBe(SECOND_AD.source_id);
    expect(row?.ad_received_at).toBe(Math.floor(newerAt / 1000) * 1000);

    const order = await fileOrder(tenant.ref(CUSTOMER));
    const stored = await getOne<{ ad_source_id: string | null }>(
      "SELECT ad_source_id FROM orders WHERE id = ?",
      [order.id],
    );
    expect(stored?.ad_source_id).toBe(SECOND_AD.source_id);
  });
});

describe("the order's ad", () => {
  async function orderRow(id: string) {
    return await getOne<{
      ad_source_id: string | null;
      ad_headline: string | null;
    }>("SELECT ad_source_id, ad_headline FROM orders WHERE id = ?", [id]);
  }

  it("records the ad when the click is inside the window", async () => {
    await deliverAd(AD);
    const order = await fileOrder(tenant.ref(CUSTOMER));
    expect(await orderRow(order.id)).toEqual({
      ad_source_id: AD.source_id,
      ad_headline: AD.headline,
    });
  });

  it("records no ad outside the window, nor without a click", async () => {
    await deliverAd(AD, { sentAt: Date.now() - 8 * DAY_MS });
    const stale = await fileOrder(tenant.ref(CUSTOMER));
    expect((await orderRow(stale.id))?.ad_source_id).toBeNull();

    const noClick = await fileOrder(tenant.ref("51987000999"));
    expect((await orderRow(noClick.id))?.ad_source_id).toBeNull();
  });
});

describe("the report's ads", () => {
  it("counts the conversations, orders and paid total per ad", async () => {
    const sentAt = Date.now() - 11 * 60 * 1000;
    await deliverAd(AD, { sentAt });
    await deliverAd(AD, { sentAt, from: "51987000222" });
    await deliverAd(SECOND_AD, { sentAt, from: "51987000333" });

    const paid = await fileOrder(tenant.ref(CUSTOMER), { amountCents: 12000 });
    await fileOrder(tenant.ref("51987000222"), { amountCents: 8000 });
    await fileOrder(tenant.ref("51987000333"), { amountCents: 5000 });

    const payment = await OrderWrites.addPayment(
      tenant.tenantId,
      paid.id,
      { methodName: "Yape", amountCents: 12000 },
      null,
    );
    await OrderWrites.decidePayment(
      tenant.tenantId,
      paid.id,
      payment!.id,
      "confirmed",
    );

    const summary = await reportSummary({
      tenantId: tenant.tenantId,
      startMs: Date.now() - DAY_MS,
      endMs: Date.now() + DAY_MS,
    });

    expect(summary.ads).toEqual([
      {
        sourceId: AD.source_id,
        headline: AD.headline,
        conversations: 2,
        orders: 2,
        paidCents: 12000,
      },
      {
        sourceId: SECOND_AD.source_id,
        headline: SECOND_AD.headline,
        conversations: 1,
        orders: 1,
        paidCents: 0,
      },
    ]);
  });

  it("leaves orders and conversations outside the range out", async () => {
    await deliverAd(AD, { sentAt: Date.now() - 30 * DAY_MS });
    await fileOrder(tenant.ref(CUSTOMER));

    const summary = await reportSummary({
      tenantId: tenant.tenantId,
      startMs: Date.now() - DAY_MS,
      endMs: Date.now() + DAY_MS,
    });
    expect(summary.ads).toEqual([]);
  });
});
