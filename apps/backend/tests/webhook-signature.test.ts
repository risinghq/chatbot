/**
 * POST /api/webhook accepts only what Meta signed with the app secret of the
 * channel the body addresses, and decides that before any message is read. A
 * body naming numbers on several channels must verify against each of them.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { getOne } from "../src/db/index.ts";
import {
  addChannelAccount,
  createTenantFixture,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { signWebhookBody } from "./helpers/webhook.ts";

import { webhookRequest } from "./helpers/turn.ts";

const CUSTOMER = "51900777888";

function delivery(phoneNumberId: string, messageId: string, text = "hola") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-signature",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                {
                  from: CUSTOMER,
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("webhook signature", () => {
  let tenant: TenantFixture;
  let messageId: string;
  let rawBody: string;
  let validSignature: string;

  beforeEach(async () => {
    tenant = await createTenantFixture("signature");
    messageId = `wamid-${crypto.randomUUID()}`;
    rawBody = JSON.stringify(delivery(tenant.phoneNumberId, messageId));
    validSignature = await signWebhookBody(rawBody, tenant.appSecret);
  });

  function post(signature: string | undefined, body = rawBody) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (signature !== undefined) headers["X-Hub-Signature-256"] = signature;
    return webhookRequest("/", { method: "POST", headers, body });
  }

  async function inboxRows(): Promise<number> {
    return (
      (await getOne(
        "SELECT COUNT(*) as c FROM message_inbox WHERE message_id = ?",
        [messageId],
      )) as { c: number }
    ).c;
  }

  async function expectRefused(response: Response) {
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_signature" });
    expect(await inboxRows()).toBe(0);
  }

  it("accepts a signature made with the channel's app secret", async () => {
    const response = await post(validSignature);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{ phoneNumberId: tenant.phoneNumberId, status: "received" }],
    });
    expect(await inboxRows()).toBe(1);
  });

  it("refuses a signature made with another channel's secret", async () => {
    const other = await addChannelAccount(tenant, {
      appSecret: "other-app-secret",
    });

    const body = JSON.stringify(delivery(other.phoneNumberId, messageId));
    await expectRefused(
      await post(await signWebhookBody(body, tenant.appSecret), body),
    );
  });

  it("refuses a request without the header", async () => {
    await expectRefused(await post(undefined));
  });

  it("refuses a body that names an unknown number, whatever the signature", async () => {
    const body = JSON.stringify(delivery("pnid-unknown", messageId));
    await expectRefused(
      await post(await signWebhookBody(body, tenant.appSecret), body),
    );
    await expectRefused(await post(undefined, body));
  });

  it("refuses a delivery to a channel that has no app secret", async () => {
    const noSecret = await addChannelAccount(tenant);
    const { getById } = await import(
      "../src/domains/channels/accounts.ts"
    ).then((m) => ({ getById: m.ChannelAccountService.getById }));
    const account = (await getById(noSecret.channelAccountId))!;
    await (await import("../src/db/index.ts")).run(
      "UPDATE channel_accounts SET app_secret_secret_id = NULL WHERE id = ?",
      [account.id],
    );

    const body = JSON.stringify(delivery(noSecret.phoneNumberId, messageId));
    await expectRefused(
      await post(await signWebhookBody(body, noSecret.appSecret), body),
    );
  });

  it("verifies a batch spanning two channels against each secret", async () => {
    const other = await addChannelAccount(tenant);
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: tenant.phoneNumberId },
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
        {
          id: "waba-2",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: other.phoneNumberId },
                messages: [],
              },
            },
          ],
        },
      ],
    });

    // Both channels share the test secret, so the delivery verifies.
    const response = await post(
      await signWebhookBody(body, tenant.appSecret),
      body,
    );
    expect(response.status).toBe(200);
  });

  it("refuses a digest without the sha256= prefix", async () => {
    await expectRefused(await post(validSignature.slice("sha256=".length)));
    await expectRefused(await post(validSignature.replace("sha256=", "sha1=")));
  });

  it("refuses a digest that is not hex", async () => {
    await expectRefused(await post(`sha256=${"z".repeat(64)}`));
  });

  it("refuses a digest of the wrong length", async () => {
    await expectRefused(await post(validSignature.slice(0, -2)));
    await expectRefused(await post(`${validSignature}00`));
  });

  it("refuses a body changed after signing", async () => {
    const tampered = rawBody.replace("hola", "chao");
    expect(tampered).not.toBe(rawBody);

    await expectRefused(await post(validSignature, tampered));
  });

  it("refuses an empty or very long header without throwing", async () => {
    await expectRefused(await post(""));
    await expectRefused(await post("sha256=".padEnd(200_000, "a")));
    await expectRefused(await post("!".repeat(200_000)));
  });

  it("refuses a body that is not JSON, signed or not", async () => {
    const garbage = "not json at all";
    await expectRefused(await post(undefined, garbage));
    await expectRefused(
      await post(await signWebhookBody(garbage, tenant.appSecret), garbage),
    );
  });

  it("refuses a body that names no phone_number_id", async () => {
    const empty = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });
    await expectRefused(await post(undefined, empty));

    const noMetadata = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-signature",
          changes: [{ field: "messages", value: { messages: [] } }],
        },
      ],
    });
    await expectRefused(await post(undefined, noMetadata));
  });

  it("answers the GET handshake for the channel's generated verify token", async () => {
    const token = await tenant.verifyToken();
    expect(token).toBeTruthy();

    const response = await webhookRequest(
      `/?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc123`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc123");
  });

  it("refuses the GET handshake for a token no channel holds", async () => {
    const response = await webhookRequest(
      "/?hub.mode=subscribe&hub.verify_token=nobody&hub.challenge=abc123",
    );

    expect(response.status).toBe(403);
  });
});
