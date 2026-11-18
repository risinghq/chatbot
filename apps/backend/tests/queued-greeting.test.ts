import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GREETING } from "@vendeya/core";

import { getOne, run } from "../src/db/index.ts";

import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { quietWindowPasses, webhookRequest } from "./helpers/turn.ts";
import {
  createTenantFixture,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { signedWebhookRequest } from "./helpers/webhook.ts";

const CUSTOMER = "51900555001";

describe("messages queued before the greeting is processed", () => {
  let tenant: TenantFixture;
  let originalFetch: typeof globalThis.fetch;
  let delivered: string[];

  beforeEach(async () => {
    tenant = await createTenantFixture("queued-greeting");
    await run("DELETE FROM channel_accounts WHERE id = ?", [
      tenant.channelAccountId,
    ]);
    const account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: tenant.phoneNumberId,
      accessToken: "EAAG-a-real-looking-token",
      appSecret: TEST_APP_SECRET,
    });
    tenant.channelAccountId = account.id;

    delivered = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        type?: string;
        text?: { body?: string };
      };
      if (body.type === "text" && body.text?.body) {
        delivered.push(body.text.body);
      }
      return new Response(
        JSON.stringify({ messages: [{ id: `wamid-out-${delivered.length}` }] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
  });

  async function customerSends(messages: string[]): Promise<void> {
    const timestamp = Math.floor((Date.now() - 11 * 60 * 1000) / 1000);
    for (const [index, body] of messages.entries()) {
      const response = await webhookRequest(
        "/",
        await signedWebhookRequest({
          object: "whatsapp_business_account",
          entry: [
            {
              id: "waba-queued-greeting",
              changes: [
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: {
                      phone_number_id: tenant.phoneNumberId,
                    },
                    messages: [
                      {
                        from: CUSTOMER,
                        id: `wamid-in-${crypto.randomUUID()}-${index}`,
                        timestamp: String(timestamp + index),
                        type: "text",
                        text: { body },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );

      expect(response.status).toBe(200);
    }
  }

  it("sends one greeting for a burst and interprets the next answer", async () => {
    await customerSends(["Hola", "Hola", "?"]);

    expect(
      (
        (await getOne(
          "SELECT COUNT(*) as count FROM message_inbox WHERE channel_account_id = ? AND status = 'pending'",
          [tenant.channelAccountId],
        )) as { count: number }
      ).count,
    ).toBe(3);
    expect(
      JSON.parse(
        (
          (await getOne(
            "SELECT context_data FROM conversations WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?",
            [tenant.tenantId, tenant.channelAccountId, CUSTOMER],
          )) as {
            context_data: string;
          }
        ).context_data,
      ).phase,
    ).toEqual({ phase: "greeting" });

    await quietWindowPasses(tenant.ref(CUSTOMER));

    expect(delivered).toHaveLength(1);
    expect(GREETING.flat()).toContain(delivered[0]!);
    expect(delivered.join(" ")).not.toContain("no te entendí");
    expect(
      (
        (await getOne(
          "SELECT COUNT(*) as count FROM message_inbox WHERE channel_account_id = ? AND status = 'processed'",
          [tenant.channelAccountId],
        )) as { count: number }
      ).count,
    ).toBe(3);

    await customerSends(["Sí"]);
    await quietWindowPasses(tenant.ref(CUSTOMER));

    expect(
      await MessageStore.getHistory(
        {
          tenantId: tenant.tenantId,
          channelAccountId: tenant.channelAccountId,
          phoneNumber: CUSTOMER,
        },
        20,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "outbound",
          content: expect.stringMatching(/DNI/i),
          status: "sent",
        }),
      ]),
    );
  });
});
