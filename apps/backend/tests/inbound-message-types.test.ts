/**
 * A photo, video, voice note, document or location reaches the assistant as a
 * bracketed text it can answer. A type with nothing to answer, such as a
 * reaction or a sticker, is ignored at the webhook.
 */

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
          id: "waba-message-types",
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

function bodyOf(message: Record<string, unknown>): string {
  return parseIncomingMessage({ id: "wamid-1", from: CUSTOMER, ...message })
    .body;
}

describe("an inbound message's text", () => {
  it("names a photo and keeps its caption", () => {
    expect(bodyOf({ type: "image", image: { id: "m1" } })).toBe("[Foto]");
    expect(
      bodyOf({ type: "image", image: { id: "m1", caption: " pago " } }),
    ).toBe("[Foto] pago");
  });

  it("names a document by its file name", () => {
    expect(
      bodyOf({
        type: "document",
        document: { id: "m2", filename: "voucher.pdf" },
      }),
    ).toBe("[Documento: voucher.pdf]");
  });

  it("names a voice note and a video", () => {
    expect(bodyOf({ type: "audio", audio: { id: "m3" } })).toBe(
      "[Nota de voz]",
    );
    expect(bodyOf({ type: "video", video: { id: "m4" } })).toBe("[Video]");
  });

  it("gives a shared location its place and a map link", () => {
    expect(
      bodyOf({
        type: "location",
        location: {
          latitude: -12.04,
          longitude: -77.03,
          name: "Mercado Central",
          address: "Jr. Huallaga 600",
        },
      }),
    ).toBe(
      "[Ubicación: Mercado Central, Jr. Huallaga 600] https://maps.google.com/?q=-12.04,-77.03",
    );
  });

  it("reads no type it does not know as text", () => {
    for (const type of ["reaction", "sticker", "contacts", "??"]) {
      expect(
        parseIncomingMessage({ id: "wamid-1", from: CUSTOMER, type }).type,
      ).toBe("unknown");
    }
  });
});

describe("at the webhook", () => {
  let tenant: TenantFixture;

  beforeEach(async () => {
    tenant = await createTenantFixture("message-types");
  });

  for (const [type, payload] of [
    ["reaction", { reaction: { message_id: "wamid-x", emoji: "\u{1F44D}" } }],
    ["sticker", { sticker: { id: "media-1", mime_type: "image/webp" } }],
  ] as const) {
    it(`ignores a ${type}`, async () => {
      const response = await deliver(tenant.phoneNumberId, {
        id: `wamid-${crypto.randomUUID()}`,
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
        { phoneNumberId: tenant.phoneNumberId, status: "unsupported_ignored" },
      ]);
      expect(await count("message_inbox", tenant.tenantId)).toBe(0);
      expect(await count("messages", tenant.tenantId)).toBe(0);
      expect(await count("conversations", tenant.tenantId)).toBe(0);
    });
  }

  it("queues a photo for the assistant with its caption", async () => {
    const response = await deliver(tenant.phoneNumberId, {
      id: `wamid-${crypto.randomUUID()}`,
      type: "image",
      image: { id: "media-2", mime_type: "image/jpeg", caption: "ya pagué" },
    });

    expect(
      ((await response.json()) as { results: Array<{ status: string }> })
        .results[0]?.status,
    ).toBe("received");
    expect(
      await getOne(
        "SELECT message_text FROM message_inbox WHERE tenant_id = ?",
        [tenant.tenantId],
      ),
    ).toEqual({ message_text: "[Foto] ya pagué" });
  });

  it("queues a text message", async () => {
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
