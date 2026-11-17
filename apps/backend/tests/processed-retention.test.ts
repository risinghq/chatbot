/**
 * A message that was answered stays recognised by its Meta id until the
 * retention passes. Meta redelivers a webhook it considers unacknowledged, and
 * `isQueued` is the only record of ids already taken in.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { getOne, run } from "../src/db/index.ts";
import { createTenantFixture, type TenantFixture } from "./helpers/tenancy.ts";

import { webhookRequest } from "./helpers/turn.ts";
import { signedWebhookRequest } from "./helpers/webhook.ts";
import { isQueued } from "../src/conversation/message-inbox.ts";
import {
  PROCESSED_MESSAGE_RETENTION_MS,
  purgeProcessedMessages,
} from "../src/conversation/processed-retention.ts";

const CUSTOMER = "51900444555";

function inbound(phoneNumberId: string, messageId: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-retention",
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
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "hola" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function deliver(phoneNumberId: string, messageId: string) {
  const response = await webhookRequest(
    "/",
    await signedWebhookRequest(inbound(phoneNumberId, messageId)),
  );
  const body = (await response.json()) as {
    results: Array<{ status: string }>;
  };
  return body.results.map((result) => result.status);
}

async function inboxRows(messageId: string): Promise<number> {
  return (
    (await getOne(
      "SELECT COUNT(*) as c FROM message_inbox WHERE message_id = ?",
      [messageId],
    )) as { c: number }
  ).c;
}

describe("a message after it has been answered", () => {
  let alpha: TenantFixture;
  let messageId: string;

  beforeEach(async () => {
    alpha = await createTenantFixture("alpha-retention");
    messageId = `wamid-${crypto.randomUUID()}`;
  });

  it("is still recognised when Meta delivers it again", async () => {
    expect(await deliver(alpha.phoneNumberId, messageId)).toEqual(["received"]);

    await run(
      "UPDATE message_inbox SET status = 'processed', processed_at = ? WHERE message_id = ?",
      [Date.now(), messageId],
    );

    expect(await deliver(alpha.phoneNumberId, messageId)).toEqual([
      "duplicate",
    ]);
    expect(await inboxRows(messageId)).toBe(1);
  });
});

describe("purging answered messages", () => {
  const NOW = Date.now();
  const EXPIRED = NOW - PROCESSED_MESSAGE_RETENTION_MS - 1;
  const RECENT = NOW - PROCESSED_MESSAGE_RETENTION_MS + 60_000;
  const LONG_AGO = NOW - 30 * PROCESSED_MESSAGE_RETENTION_MS;

  let alpha: TenantFixture;

  async function queued(
    status: string,
    processedAt: number | null,
  ): Promise<string> {
    const messageId = `wamid-${crypto.randomUUID()}`;
    await run(
      `INSERT INTO message_inbox
         (tenant_id, channel_account_id, phone_number, message_text, message_id,
          whatsapp_timestamp, status, created_at, processed_at)
       VALUES (?, ?, ?, 'hola', ?, 1, ?, ?, ?)`,
      [
        alpha.tenantId,
        alpha.channelAccountId,
        CUSTOMER,
        messageId,
        status,
        LONG_AGO,
        processedAt,
      ],
    );
    return messageId;
  }

  beforeEach(async () => {
    alpha = await createTenantFixture("alpha-purge");
  });

  it("forgets ids answered longer ago than the retention", async () => {
    const id = await queued("processed", EXPIRED);

    expect(await purgeProcessedMessages(NOW)).toBe(1);

    expect(await isQueued(id)).toBe(false);
  });

  it("keeps ids answered within the retention", async () => {
    const id = await queued("processed", RECENT);

    expect(await purgeProcessedMessages(NOW)).toBe(0);

    expect(await isQueued(id)).toBe(true);
  });

  it("keeps messages that were never answered, however old", async () => {
    const id = await queued("pending", null);

    expect(await purgeProcessedMessages(NOW)).toBe(0);

    expect(await isQueued(id)).toBe(true);
  });
});
