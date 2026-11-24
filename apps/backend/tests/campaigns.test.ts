import { describe, expect, it, vi } from "vitest";
import { newId } from "@vendeya/utils";
import { getAll, getOne, run } from "./helpers/db.ts";
import { fakeGraph } from "./helpers/graph.ts";
import {
  createTenantFixture,
  fileOrder,
  insertTenant,
} from "./helpers/tenancy.ts";
import { backendFetch, customerWrites, sweepAt } from "./helpers/turn.ts";
import { signedWebhookRequest } from "./helpers/webhook.ts";
import { resolveAudience } from "../src/domains/campaigns/audience.ts";
import { isOptedOut } from "../src/domains/campaigns/consent.ts";
import {
  CampaignService,
  dispatchDueCampaigns,
} from "../src/domains/campaigns/campaigns.ts";
import { enqueueTemplate } from "../src/domains/campaigns/send.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** An approved template row, the shape the webhook path leaves behind. */
async function approvedTemplate(
  tenantId: string,
  category: "marketing" | "utility" = "marketing",
): Promise<string> {
  const id = newId();
  await run(
    `INSERT INTO message_templates (id, tenant_id, name, language, category, body, params, status, meta_template_id, created_at, updated_at)
     VALUES (?, ?, ?, 'es', ?, 'Hola {{1}}', '[{"kind":"field","field":"customer_name"}]', 'approved', ?, ?, ?)`,
    [
      id,
      tenantId,
      `tpl_${id}`,
      category,
      `meta-${id.slice(0, 8)}`,
      Date.now(),
      Date.now(),
    ],
  );
  return id;
}

async function createCampaign(
  tenantId: string,
  templateId: string,
  audience: object,
  scheduledAt: number | null = null,
) {
  const id = newId();
  await run(
    `INSERT INTO campaigns (id, tenant_id, name, template_id, audience, params, status, scheduled_at, created_at, updated_at)
     VALUES (?, ?, 'Campana', ?, ?, '[]', 'scheduled', ?, ?, ?)`,
    [
      id,
      tenantId,
      templateId,
      JSON.stringify(audience),
      scheduledAt ?? Date.now(),
      Date.now(),
      Date.now(),
    ],
  );
  return id;
}

async function withCustomer(tenantId: string, phone: string, name = "Cliente") {
  await run(
    "INSERT INTO customers (id, tenant_id, name, phone) VALUES (?, ?, ?, ?)",
    [newId(), tenantId, name, phone],
  );
}

async function recipientsOf(campaignId: string) {
  return getAll<{
    phone_number: string;
    status: string;
    skip_reason: string | null;
    replied_at: number | null;
  }>(
    "SELECT phone_number, status, skip_reason, replied_at FROM campaign_recipients WHERE campaign_id = ? ORDER BY phone_number",
    [campaignId],
  );
}

describe("campaigns", () => {
  it("counts the audience each kind selects", async () => {
    const tenantId = await insertTenant();
    await withCustomer(tenantId, "51900000001");
    await withCustomer(tenantId, "51900000002");
    await withCustomer(tenantId, "51900000003"); // no orders

    // One order ties the second customer to the catalog.
    await run(
      `INSERT INTO products (id, tenant_id, name, category, status) VALUES (?, ?, 'Refresco', 'Bebidas', 'active')`,
      ["prod-1", tenantId],
    );
    await run(
      `INSERT INTO product_variants (id, tenant_id, product_id, sku, price_cents) VALUES (?, ?, ?, 'SKU-1', 500)`,
      ["var-1", tenantId, "prod-1"],
    );
    const customer = await getOne<{ id: string }>(
      "SELECT id FROM customers WHERE phone = '51900000002' AND tenant_id = ?",
      [tenantId],
    );
    const orderId = newId();
    await run(
      `INSERT INTO orders (id, tenant_id, number, customer_id, status, subtotal_cents, total_cents, source)
       VALUES (?, ?, 1, ?, 'delivered', 500, 500, 'staff')`,
      [orderId, tenantId, customer!.id],
    );
    await run(
      `INSERT INTO order_lines (id, tenant_id, order_id, variant_id, name, quantity, unit_price_cents, position)
       VALUES (?, ?, ?, 'var-1', 'Refresco', 1, 500, 0)`,
      [newId(), tenantId, orderId],
    );

    const all = await resolveAudience(tenantId, { kind: "all" }, Date.now());
    expect(all).toHaveLength(3);

    const category = await resolveAudience(
      tenantId,
      { kind: "category", category: "Bebidas" },
      Date.now(),
    );
    expect(category).toHaveLength(1);
    expect(category[0]!.phone_number).toBe("51900000002");

    const product = await resolveAudience(
      tenantId,
      { kind: "product", product_id: "prod-1" },
      Date.now(),
    );
    expect(product).toHaveLength(1);

    const phones = await resolveAudience(
      tenantId,
      { kind: "phones", phones: ["+51 900 000 001", "51900000009"] },
      Date.now(),
    );
    expect(phones.map((p) => p.phone_number)).toEqual([
      "51900000001",
      "51900000009",
    ]);

    const inactive = await resolveAudience(
      tenantId,
      { kind: "inactive", days: 45 },
      Date.now(),
    );
    // The order was written today, so nobody qualifies yet.
    expect(inactive).toHaveLength(0);
    await run("UPDATE orders SET updated_at = ? WHERE id = ?", [
      Date.now() - 50 * DAY,
      orderId,
    ]);
    expect(
      await resolveAudience(
        tenantId,
        { kind: "inactive", days: 45 },
        Date.now(),
      ),
    ).toHaveLength(1);
  });

  it("opts a customer out when they write 'baja' and confirms it", async () => {
    const tenant = await createTenantFixture("Opt-out");
    const graph = fakeGraph();
    try {
      await customerWrites(tenant, "51900000010", "baja");

      expect(await isOptedOut(tenant.tenantId, "51900000010")).toBe(true);
      expect(
        (await getOne<{ source: string }>(
          "SELECT source FROM marketing_opt_outs WHERE tenant_id = ? AND phone_number = ?",
          [tenant.tenantId, "51900000010"],
        ))!.source,
      ).toBe("message");
      expect(graph.replies().some((s) => s.payload.type === "text")).toBe(true);
    } finally {
      graph.restore();
    }
  });

  it("sends a scheduled campaign from the sweep through the outbox", async () => {
    const tenant = await createTenantFixture("Campaign send");
    const graph = fakeGraph();
    try {
      const phone = "51900000020";
      await withCustomer(tenant.tenantId, phone);
      const templateId = await approvedTemplate(tenant.tenantId);
      const campaignId = await createCampaign(
        tenant.tenantId,
        templateId,
        { kind: "all" },
        Date.now() - 1000,
      );

      await sweepAt();

      const templateSend = graph.sends.find(
        (s) => s.payload.type === "template",
      );
      expect(templateSend).toBeDefined();
      expect(templateSend!.payload.to).toBe(phone);

      const campaign = await getOne<{ status: string }>(
        "SELECT status FROM campaigns WHERE id = ?",
        [campaignId],
      );
      expect(campaign!.status).toBe("sent");
      const recipients = await recipientsOf(campaignId);
      expect(recipients).toHaveLength(1);
      expect(recipients[0]!.status).toBe("queued");
      const outbox = await getOne<{ type: string; status: string }>(
        "SELECT type, status FROM outbox WHERE tenant_id = ?",
        [tenant.tenantId],
      );
      expect(outbox).toMatchObject({ type: "template" });
      expect(["sent", "pending", "sending"]).toContain(outbox!.status);
    } finally {
      graph.restore();
    }
  });

  it("skips opted-out and recently marketed phones under the 7-day cap", async () => {
    const tenant = await createTenantFixture("Cap");
    fakeGraph();
    const optedOutPhone = "51900000030";
    const cappedPhone = "51900000031";
    const freshPhone = "51900000032";
    for (const phone of [optedOutPhone, cappedPhone, freshPhone]) {
      await withCustomer(tenant.tenantId, phone);
    }
    await run(
      "INSERT INTO marketing_opt_outs (tenant_id, phone_number, source) VALUES (?, ?, 'staff')",
      [tenant.tenantId, optedOutPhone],
    );

    const templateId = await approvedTemplate(tenant.tenantId);
    const first = await createCampaign(tenant.tenantId, templateId, {
      kind: "phones",
      phones: [cappedPhone],
    });
    await dispatchDueCampaigns(Date.now());
    expect((await recipientsOf(first))[0]!.status).toBe("queued");

    const second = await createCampaign(tenant.tenantId, templateId, {
      kind: "all",
    });
    await dispatchDueCampaigns(Date.now());

    const byPhone = Object.fromEntries(
      (await recipientsOf(second)).map((r) => [r.phone_number, r]),
    );
    expect(byPhone[optedOutPhone]!.status).toBe("skipped");
    expect(byPhone[optedOutPhone]!.skip_reason).toBe("opted_out");
    expect(byPhone[cappedPhone]!.status).toBe("skipped");
    expect(byPhone[cappedPhone]!.skip_reason).toBe("capped");
    expect(byPhone[freshPhone]!.status).toBe("queued");
  });

  it("refuses to send a campaign whose template is not approved", async () => {
    const tenant = await createTenantFixture("Refusal");
    const phone = "51900000040";
    await withCustomer(tenant.tenantId, phone);
    const templateId = newId();
    await run(
      `INSERT INTO message_templates (id, tenant_id, name, language, category, body, status)
       VALUES (?, ?, 'tpl_pending', 'es', 'marketing', 'Hola', 'pending')`,
      [templateId, tenant.tenantId],
    );
    const campaignId = await createCampaign(tenant.tenantId, templateId, {
      kind: "all",
    });

    await dispatchDueCampaigns(Date.now());

    const campaign = await getOne<{ status: string; failure_reason: string }>(
      "SELECT status, failure_reason FROM campaigns WHERE id = ?",
      [campaignId],
    );
    expect(campaign!.status).toBe("failed");
    expect(campaign!.failure_reason).toBe("template_not_approved");
  });

  it("counts sent, delivered, read, replied and orders from the webhook", async () => {
    const tenant = await createTenantFixture("Results");
    const graph = fakeGraph();
    try {
      const phone = "51900000050";
      await withCustomer(tenant.tenantId, phone);
      const templateId = await approvedTemplate(tenant.tenantId);

      // The send response carries Meta's id; the webhook reports on it.
      const whatsappId = `wamid-${crypto.randomUUID()}`;
      graph.respondWith(() =>
        Response.json({ messages: [{ id: whatsappId }] }),
      );
      const campaignId2 = await createCampaign(tenant.tenantId, templateId, {
        kind: "all",
      });
      await sweepAt();
      const message = await getOne<{ id: string }>(
        "SELECT id FROM messages WHERE whatsapp_message_id = ?",
        [whatsappId],
      );
      expect(message).toBeDefined();

      const statusBody = (status: string) => ({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba-test",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    display_phone_number: "51900000000",
                    phone_number_id: tenant.phoneNumberId,
                  },
                  statuses: [
                    {
                      id: whatsappId,
                      status,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: phone,
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      for (const status of ["sent", "delivered", "read"]) {
        const res = await backendFetch(
          "/api/webhook",
          await signedWebhookRequest(statusBody(status)),
        );
        expect(res.status).toBe(200);
      }

      // The customer answers: the recipient row counts it as a reply.
      await customerWrites(tenant, phone, "me interesa");

      const recipients = await recipientsOf(campaignId2);
      expect(recipients[0]!.status).toBe("read");
      expect(recipients[0]!.replied_at).not.toBeNull();

      const summary = await CampaignService.get(tenant.tenantId, campaignId2);
      expect(summary!.results).toMatchObject({
        targeted: 1,
        sent: 1,
        delivered: 1,
        read: 1,
        replied: 1,
      });

      // An order filed inside the 7-day window is credited to the campaign.
      await fileOrder(tenant.ref(phone));
      const after = await CampaignService.get(tenant.tenantId, campaignId2);
      expect(after!.results.orders).toBe(1);
      expect(after!.results.orders_total_cents).toBe(10000);
    } finally {
      graph.restore();
    }
  });

  it("sends the cart reminder once for an unpaid pending order", async () => {
    const tenant = await createTenantFixture("Cart reminder");
    const graph = fakeGraph();
    try {
      const phone = "51900000060";
      const order = await fileOrder(tenant.ref(phone), { amountCents: 5000 });
      // Old enough that the 4-hour default fires it.
      const stale = Date.now() - 5 * HOUR;
      await run(
        `UPDATE orders SET created_at = ?,
           updated_at = ? WHERE id = ?`,
        [stale, stale, order.id],
      );

      const templateId = await approvedTemplate(tenant.tenantId, "utility");
      await run(
        `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
         VALUES (?, 'reminder_cart_enabled', '1', ?), (?, 'reminder_cart_template_id', ?, ?)`,
        [tenant.tenantId, Date.now(), tenant.tenantId, templateId, Date.now()],
      );

      await sweepAt();
      let sends = graph.sends.filter((s) => s.payload.type === "template");
      expect(sends).toHaveLength(1);
      expect(sends[0]!.payload.to).toBe(phone);

      // A second pass finds the stamp and sends nothing again.
      await sweepAt();
      sends = graph.sends.filter((s) => s.payload.type === "template");
      expect(sends).toHaveLength(1);
      expect(
        await getOne("SELECT cart_reminder_sent_at FROM orders WHERE id = ?", [
          order.id,
        ]),
      ).toBeDefined();
    } finally {
      graph.restore();
    }
  });

  it("sends the inactive reminder once per inactive spell", async () => {
    const tenant = await createTenantFixture("Inactive");
    const graph = fakeGraph();
    try {
      const phone = "51900000070";
      const order = await fileOrder(tenant.ref(phone));
      const stale = Date.now() - 50 * DAY;
      await run(
        "UPDATE orders SET status = 'delivered', updated_at = ? WHERE id = ?",
        [stale, order.id],
      );

      const templateId = await approvedTemplate(tenant.tenantId, "utility");
      await run(
        `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
         VALUES (?, 'reminder_inactive_enabled', '1', ?), (?, 'reminder_inactive_template_id', ?, ?)`,
        [tenant.tenantId, Date.now(), tenant.tenantId, templateId, Date.now()],
      );

      await sweepAt();
      const sends = graph.sends.filter((s) => s.payload.type === "template");
      expect(sends).toHaveLength(1);

      // Same spell: nothing again. A newer delivered order opens a new spell.
      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(1);

      await run("UPDATE orders SET updated_at = ? WHERE id = ?", [
        Date.now() + 1000,
        order.id,
      ]);
      await sweepAt(Date.now() + 46 * DAY);
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(2);

      // A write with no new order also opens a new spell.
      const stamp = Date.now() + 46 * DAY;
      await customerWrites(tenant, phone, "hola de nuevo");
      await run(
        "UPDATE messages SET created_at = ? WHERE tenant_id = ? AND direction = 'inbound'",
        [stamp + 1000, tenant.tenantId],
      );
      await sweepAt(stamp + 46 * DAY);
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(3);
      vi.useRealTimers();
    } finally {
      graph.restore();
    }
  });

  it("applies a template approval from the waba webhook", async () => {
    const tenant = await createTenantFixture("Template webhook");
    await run("UPDATE channel_accounts SET waba_id = 'waba-123' WHERE id = ?", [
      tenant.channelAccountId,
    ]);
    const templateId = await approvedTemplate(tenant.tenantId);
    await run("UPDATE message_templates SET status = 'pending' WHERE id = ?", [
      templateId,
    ]);

    const res = await backendFetch(
      "/api/webhook",
      await signedWebhookRequest({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba-123",
            changes: [
              {
                field: "message_template_status_update",
                value: {
                  event: "APPROVED",
                  message_template_id: `meta-${templateId.slice(0, 8)}`,
                  message_template_name: `tpl_${templateId.slice(0, 8)}`,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const template = await getOne<{ status: string }>(
      "SELECT status FROM message_templates WHERE id = ?",
      [templateId],
    );
    expect(template!.status).toBe("approved");
  });

  it("caps a campaign after a marketing reminder to the same phone", async () => {
    const tenant = await createTenantFixture("Reminder caps campaign");
    const graph = fakeGraph();
    try {
      const phone = "51900000090";
      const order = await fileOrder(tenant.ref(phone));
      await run("UPDATE orders SET created_at = ? WHERE id = ?", [
        Date.now() - 5 * 60 * 60 * 1000,
        order.id,
      ]);
      const templateId = await approvedTemplate(tenant.tenantId, "marketing");
      await run(
        `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
         VALUES (?, 'reminder_cart_enabled', '1', ?), (?, 'reminder_cart_template_id', ?, ?)`,
        [tenant.tenantId, Date.now(), tenant.tenantId, templateId, Date.now()],
      );
      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(1);

      const campaignId = await createCampaign(tenant.tenantId, templateId, {
        kind: "all",
      });
      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(1);
      const recipients = await recipientsOf(campaignId);
      expect(recipients).toHaveLength(1);
      expect(recipients[0]!.status).toBe("skipped");
      expect(recipients[0]!.skip_reason).toBe("capped");
    } finally {
      graph.restore();
    }
  });

  it("caps a marketing reminder after a campaign to the same phone", async () => {
    const tenant = await createTenantFixture("Campaign caps reminder");
    const graph = fakeGraph();
    try {
      const phone = "51900000091";
      const order = await fileOrder(tenant.ref(phone));
      await run("UPDATE orders SET created_at = ? WHERE id = ?", [
        Date.now() - 5 * 60 * 60 * 1000,
        order.id,
      ]);
      const templateId = await approvedTemplate(tenant.tenantId, "marketing");
      await createCampaign(tenant.tenantId, templateId, { kind: "all" });
      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(1);

      await run(
        `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
         VALUES (?, 'reminder_cart_enabled', '1', ?), (?, 'reminder_cart_template_id', ?, ?)`,
        [tenant.tenantId, Date.now(), tenant.tenantId, templateId, Date.now()],
      );
      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(1);
      expect(
        (await getOne<{ cart_reminder_sent_at: number | null }>(
          "SELECT cart_reminder_sent_at FROM orders WHERE id = ?",
          [order.id],
        ))!.cart_reminder_sent_at,
      ).toBeNull();
    } finally {
      graph.restore();
    }
  });

  it("sends one marketing cart reminder for two stale orders of one customer", async () => {
    const tenant = await createTenantFixture("Two stale orders");
    const graph = fakeGraph();
    try {
      const phone = "51900000092";
      await fileOrder(tenant.ref(phone));
      await fileOrder(tenant.ref(phone));
      await run("UPDATE orders SET created_at = ? WHERE tenant_id = ?", [
        Date.now() - 5 * 60 * 60 * 1000,
        tenant.tenantId,
      ]);
      const templateId = await approvedTemplate(tenant.tenantId, "marketing");
      await run(
        `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
         VALUES (?, 'reminder_cart_enabled', '1', ?), (?, 'reminder_cart_template_id', ?, ?)`,
        [tenant.tenantId, Date.now(), tenant.tenantId, templateId, Date.now()],
      );
      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(1);
      const stamps = await getAll<{ id: string; stamped: number | null }>(
        "SELECT id, cart_reminder_sent_at AS stamped FROM orders WHERE tenant_id = ?",
        [tenant.tenantId],
      );
      expect(stamps.filter((s) => s.stamped !== null)).toHaveLength(1);
    } finally {
      graph.restore();
    }
  });

  it("ignores the cap for a utility reminder", async () => {
    const tenant = await createTenantFixture("Utility ignores cap");
    const graph = fakeGraph();
    try {
      const phone = "51900000093";
      const order = await fileOrder(tenant.ref(phone));
      await run("UPDATE orders SET created_at = ? WHERE id = ?", [
        Date.now() - 5 * 60 * 60 * 1000,
        order.id,
      ]);
      const marketingId = await approvedTemplate(tenant.tenantId, "marketing");
      await createCampaign(tenant.tenantId, marketingId, { kind: "all" });
      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(1);

      const utilityId = await approvedTemplate(tenant.tenantId, "utility");
      await run(
        `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
         VALUES (?, 'reminder_cart_enabled', '1', ?), (?, 'reminder_cart_template_id', ?, ?)`,
        [tenant.tenantId, Date.now(), tenant.tenantId, utilityId, Date.now()],
      );
      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(2);
    } finally {
      graph.restore();
    }
  });

  it("lets only one of two concurrent marketing sends through the cap", async () => {
    const tenant = await createTenantFixture("Concurrent cap claim");
    const graph = fakeGraph();
    try {
      const phone = "51900000094";
      const ref = tenant.ref(phone);
      const template = await getOne<{
        name: string;
        language: string;
        body: string;
      }>(
        "SELECT name, language, body FROM message_templates WHERE tenant_id = ? AND id = ?",
        [tenant.tenantId, await approvedTemplate(tenant.tenantId, "marketing")],
      );
      // One clock reading, as one sweep pass gives every sender.
      const now = Date.now();
      const [a, b] = await Promise.all([
        enqueueTemplate(ref, template!, [], {}, now, 7),
        enqueueTemplate(ref, template!, [], {}, now, 7),
      ]);
      const ids = [a, b].filter((r) => r !== "opted_out" && r !== "capped");
      expect(ids).toHaveLength(1);
      const rows = await getAll<{ id: string }>(
        "SELECT id FROM outbox WHERE tenant_id = ? AND type = 'template'",
        [tenant.tenantId],
      );
      expect(rows).toHaveLength(1);
    } finally {
      graph.restore();
    }
  });

  it("commits no cap claim when the batch fails after it", async () => {
    const tenant = await createTenantFixture("Claim rollback");
    const graph = fakeGraph();
    const phone = "51900000095";
    // Fails the outbox insert, the batch's last statement, after the claim
    // and the messages insert have run.
    await run(
      `CREATE TRIGGER fail_outbox_insert BEFORE INSERT ON outbox
       WHEN NEW.phone_number = '${phone}'
       BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END`,
      [],
    );
    try {
      const ref = tenant.ref(phone);
      const template = await getOne<{
        name: string;
        language: string;
        body: string;
      }>(
        "SELECT name, language, body FROM message_templates WHERE tenant_id = ? AND id = ?",
        [tenant.tenantId, await approvedTemplate(tenant.tenantId, "marketing")],
      );
      await expect(
        enqueueTemplate(ref, template!, [], {}, Date.now(), 7),
      ).rejects.toThrow(/forced outbox failure/);
      for (const table of ["marketing_sends", "messages", "outbox"]) {
        const row = await getOne<{ n: number }>(
          `SELECT count(*) AS n FROM ${table} WHERE tenant_id = ? AND phone_number = ?`,
          [tenant.tenantId, phone],
        );
        expect(row!.n, `${table} should hold no row`).toBe(0);
      }
    } finally {
      await run("DROP TRIGGER fail_outbox_insert", []);
      graph.restore();
    }
  });

  it.each(["marketing", "utility"] as const)(
    "commits a %s campaign send only with its recipient marked queued",
    async (category) => {
      const tenant = await createTenantFixture(`Recipient batch ${category}`);
      const graph = fakeGraph();
      const phone = category === "marketing" ? "51900000097" : "51900000098";
      // Fails marking the recipient queued, the batch's last statement.
      await run(
        `CREATE TRIGGER fail_recipient_queued BEFORE UPDATE OF status ON campaign_recipients
         WHEN NEW.status = 'queued'
         BEGIN SELECT RAISE(ABORT, 'forced recipient failure'); END`,
        [],
      );
      try {
        await withCustomer(tenant.tenantId, phone);
        const campaignId = await createCampaign(
          tenant.tenantId,
          await approvedTemplate(tenant.tenantId, category),
          { kind: "all" },
          Date.now() - 1000,
        );
        await dispatchDueCampaigns(Date.now());
        for (const table of ["marketing_sends", "messages", "outbox"]) {
          const row = await getOne<{ n: number }>(
            `SELECT count(*) AS n FROM ${table} WHERE tenant_id = ? AND phone_number = ?`,
            [tenant.tenantId, phone],
          );
          expect(row!.n, `${table} should hold no row`).toBe(0);
        }
        expect((await recipientsOf(campaignId))[0]!.status).toBe("pending");
      } finally {
        await run("DROP TRIGGER fail_recipient_queued", []);
        graph.restore();
      }
    },
  );

  it("returns capped and writes nothing for a phone inside the window", async () => {
    const tenant = await createTenantFixture("In-window cap");
    const graph = fakeGraph();
    try {
      const phone = "51900000096";
      const earlier = Date.now() - 2 * DAY;
      await run(
        "INSERT INTO marketing_sends (tenant_id, phone_number, sent_at, message_id) VALUES (?, ?, ?, 'earlier')",
        [tenant.tenantId, phone, earlier],
      );
      const template = await getOne<{
        name: string;
        language: string;
        body: string;
      }>(
        "SELECT name, language, body FROM message_templates WHERE tenant_id = ? AND id = ?",
        [tenant.tenantId, await approvedTemplate(tenant.tenantId, "marketing")],
      );
      const optedOutPhone = "51900000088";
      await run(
        "INSERT INTO marketing_opt_outs (tenant_id, phone_number, source) VALUES (?, ?, 'staff')",
        [tenant.tenantId, optedOutPhone],
      );
      await expect(
        enqueueTemplate(tenant.ref(phone), template!, [], {}, Date.now(), 7),
      ).resolves.toBe("capped");
      await expect(
        enqueueTemplate(
          tenant.ref(optedOutPhone),
          template!,
          [],
          {},
          Date.now(),
          7,
        ),
      ).resolves.toBe("opted_out");
      for (const refusedPhone of [phone, optedOutPhone]) {
        for (const table of ["conversations", "messages", "outbox"]) {
          const row = await getOne<{ n: number }>(
            `SELECT count(*) AS n FROM ${table} WHERE tenant_id = ? AND phone_number = ?`,
            [tenant.tenantId, refusedPhone],
          );
          expect(row!.n, `${table} should hold no row`).toBe(0);
        }
      }
      const claim = await getOne<{ sent_at: number; message_id: string }>(
        "SELECT sent_at, message_id FROM marketing_sends WHERE tenant_id = ? AND phone_number = ?",
        [tenant.tenantId, phone],
      );
      expect(claim).toEqual({ sent_at: earlier, message_id: "earlier" });
    } finally {
      graph.restore();
    }
  });

  it("reaches eligible customers past 50 opted-out ones on a marketing reminder", async () => {
    const tenant = await createTenantFixture("Inactive starvation");
    const graph = fakeGraph();
    try {
      for (let i = 0; i < 50; i++) {
        const phone = `519100000${String(i).padStart(2, "0")}`;
        const customerId = newId();
        await run(
          "INSERT INTO customers (id, tenant_id, name, phone) VALUES (?, ?, 'Cliente', ?)",
          [customerId, tenant.tenantId, phone],
        );
        await run(
          `INSERT INTO orders (id, tenant_id, number, customer_id, status, subtotal_cents, total_cents, source)
           VALUES (?, ?, ?, ?, 'delivered', 500, 500, 'staff')`,
          [newId(), tenant.tenantId, 1000 + i, customerId],
        );
        await run(
          "INSERT INTO marketing_opt_outs (tenant_id, phone_number, source) VALUES (?, ?, 'message')",
          [tenant.tenantId, phone],
        );
      }
      const eligiblePhone = "51910000100";
      const eligibleId = newId();
      await run(
        "INSERT INTO customers (id, tenant_id, name, phone) VALUES (?, ?, 'Cliente', ?)",
        [eligibleId, tenant.tenantId, eligiblePhone],
      );
      await run(
        `INSERT INTO orders (id, tenant_id, number, customer_id, status, subtotal_cents, total_cents, source)
         VALUES (?, ?, 2000, ?, 'delivered', 500, 500, 'staff')`,
        [newId(), tenant.tenantId, eligibleId],
      );
      await run("UPDATE orders SET updated_at = ? WHERE tenant_id = ?", [
        Date.now() - 50 * DAY,
        tenant.tenantId,
      ]);

      const templateId = await approvedTemplate(tenant.tenantId, "marketing");
      await run(
        `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
         VALUES (?, 'reminder_inactive_enabled', '1', ?), (?, 'reminder_inactive_template_id', ?, ?)`,
        [tenant.tenantId, Date.now(), tenant.tenantId, templateId, Date.now()],
      );

      await sweepAt();
      expect(
        graph.sends.filter((s) => s.payload.type === "template"),
      ).toHaveLength(1);
      const rows = await getAll<{ phone_number: string }>(
        "SELECT phone_number FROM outbox WHERE tenant_id = ? AND type = 'template'",
        [tenant.tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.phone_number.endsWith(eligiblePhone)).toBe(true);
    } finally {
      graph.restore();
    }
  });

  it.each([
    ["opted out", "opt_out"],
    ["inside the cap", "cap"],
  ])(
    "skips a marketing inactive reminder when the phone is %s",
    async (_label, kind) => {
      const tenant = await createTenantFixture("Inactive consent");
      const graph = fakeGraph();
      try {
        const phone = "51900000080";
        const order = await fileOrder(tenant.ref(phone));
        const stale = Date.now() - 50 * DAY;
        await run(
          "UPDATE orders SET status = 'delivered', updated_at = ? WHERE id = ?",
          [stale, order.id],
        );

        const templateId = await approvedTemplate(tenant.tenantId, "marketing");
        await run(
          `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
         VALUES (?, 'reminder_inactive_enabled', '1', ?), (?, 'reminder_inactive_template_id', ?, ?)`,
          [
            tenant.tenantId,
            Date.now(),
            tenant.tenantId,
            templateId,
            Date.now(),
          ],
        );

        if (kind === "opt_out") {
          await run(
            "INSERT INTO marketing_opt_outs (tenant_id, phone_number, source) VALUES (?, ?, 'message')",
            [tenant.tenantId, phone],
          );
        } else {
          await run(
            "INSERT INTO marketing_sends (tenant_id, phone_number, sent_at, message_id) VALUES (?, ?, ?, 'earlier')",
            [tenant.tenantId, phone, Date.now() - 2 * DAY],
          );
        }

        await sweepAt();
        expect(
          graph.sends.filter((s) => s.payload.type === "template"),
        ).toHaveLength(0);
        expect(
          (await getOne<{ inactive_reminder_sent_at: number | null }>(
            "SELECT inactive_reminder_sent_at FROM customers WHERE tenant_id = ? AND phone = ?",
            [tenant.tenantId, phone],
          ))!.inactive_reminder_sent_at,
        ).toBeNull();
      } finally {
        graph.restore();
      }
    },
  );
});
