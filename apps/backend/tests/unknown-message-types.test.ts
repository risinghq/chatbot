/** A Cloud API message type the parser does not know is ignored at the webhook like any non-text message. */

import { describe, it, expect, beforeEach } from "vitest";

import { getOne } from "./helpers/db.ts";
import { createTenantFixture, type TenantFixture } from "./helpers/tenancy.ts";

import { webhookRequest } from "./helpers/turn.ts";
import { signedWebhookRequest } from "./helpers/webhook.ts";
import { parseIncomingMessage } from "../src/adapters/whatsapp/parsers/cloud-api-parser.ts";

const CUSTOMER = "51900444555";

async function deliver(
  phoneNumberId: string,
  message: Record<string, unknown>,
) {
  return webhookRequest(
    "/",
    await signedWebhookRequest({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-unknown-type",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "51900000000",
                  phone_number_id: phoneNumberId,
                },
                messages: [
                  {
                    from: CUSTOMER,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    ...message,
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
}

async function count(table: string, tenantId: string): Promise<number> {
  return (
    (await getOne(`SELECT COUNT(*) as c FROM ${table} WHERE tenant_id = ?`, [
      tenantId,
    ])) as { c: number }
  ).c;
}

describe("a message type the parser does not know", () => {
  it("is not read as text", async () => {
    for (const type of ["reaction", "location", "sticker", "contacts", "??"]) {
      const parsed = parseIncomingMessage({
        id: "wamid-1",
        from: CUSTOMER,
        type,
      });
      expect(parsed.type).not.toBe("text");
    }
  });

  it("still reads the types it knows", async () => {
    for (const type of ["text", "image", "document", "audio", "video"]) {
      expect(
        parseIncomingMessage({ id: "wamid-1", from: CUSTOMER, type }).type,
      ).toBe(type as never);
    }
  });

  describe("arriving at the webhook", () => {
    let tenant: TenantFixture;

    beforeEach(async () => {
      tenant = await createTenantFixture("unknown-type");
    });

    for (const [type, payload] of [
      ["reaction", { reaction: { message_id: "wamid-x", emoji: "\u{1F44D}" } }],
      ["location", { location: { latitude: -12.04, longitude: -77.03 } }],
      ["sticker", { sticker: { id: "media-1", mime_type: "image/webp" } }],
    ] as const) {
      it(`ignores a ${type} like any other non-text message`, async () => {
        const messageId = `wamid-${crypto.randomUUID()}`;

        const response = await deliver(tenant.phoneNumberId, {
          id: messageId,
          type,
          ...payload,
        });

        expect(response.status).toBe(200);
        expect(
          (
            (await response.json()) as {
              results: Array<{ phoneNumberId: string; status: string }>;
            }
          ).results,
        ).toEqual([
          { phoneNumberId: tenant.phoneNumberId, status: "non_text_ignored" },
        ]);
        expect(await count("message_inbox", tenant.tenantId)).toBe(0);
        expect(await count("messages", tenant.tenantId)).toBe(0);
        expect(await count("conversations", tenant.tenantId)).toBe(0);
      });
    }

    it("still queues a text message", async () => {
      const response = await deliver(tenant.phoneNumberId, {
        id: `wamid-${crypto.randomUUID()}`,
        type: "text",
        text: { body: "hola" },
      });

      expect(
        ((await response.json()) as { results: Array<{ status: string }> })
          .results[0]?.status,
      ).toBe("received");
      expect(await count("message_inbox", tenant.tenantId)).toBe(1);
    });
  });
});
