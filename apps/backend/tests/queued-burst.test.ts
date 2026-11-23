import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getOne, run } from "./helpers/db.ts";

import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { type FakeModel, fakeModel, withOpenAiKey } from "./helpers/model.ts";
import { quietWindowPasses, webhookRequest } from "./helpers/turn.ts";
import {
  createTenantFixture,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { signedWebhookRequest } from "./helpers/webhook.ts";

const CUSTOMER = "51900555001";

describe("messages queued before the first turn runs", () => {
  let tenant: TenantFixture;
  let originalFetch: typeof globalThis.fetch;
  let model: FakeModel;
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
    await withOpenAiKey(tenant.tenantId);

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
    model = fakeModel();
  });

  afterEach(async () => {
    model.restore();
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

  function processedCount(): Promise<number> {
    return getOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM message_inbox WHERE channel_account_id = ? AND status = 'processed'",
      [tenant.channelAccountId],
    ).then((row) => row?.count ?? 0);
  }

  it("answers a burst with one reply, and the next turn reads it", async () => {
    await customerSends(["Hola", "tienen polos?", "?"]);
    model.says("¡Hola! Sí, tenemos polos. ¿De qué talla?");

    await quietWindowPasses(tenant.ref(CUSTOMER));

    expect(delivered).toEqual(["¡Hola! Sí, tenemos polos. ¿De qué talla?"]);
    expect(model.requests).toHaveLength(1);
    expect(
      model.requests[0]?.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["Hola", "tienen polos?", "?"]);
    expect(await processedCount()).toBe(3);

    await customerSends(["M"]);
    model.says("Perfecto, talla M.");
    await quietWindowPasses(tenant.ref(CUSTOMER));

    expect(delivered).toEqual([
      "¡Hola! Sí, tenemos polos. ¿De qué talla?",
      "Perfecto, talla M.",
    ]);
    expect(
      model.requests[1]?.messages
        .filter((message) => message.role !== "system")
        .map((message) => [message.role, message.content]),
    ).toEqual([
      ["user", "Hola"],
      ["user", "tienen polos?"],
      ["user", "?"],
      ["assistant", "¡Hola! Sí, tenemos polos. ¿De qué talla?"],
      ["user", "M"],
    ]);
  });
});
