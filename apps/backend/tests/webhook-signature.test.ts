/**
 * POST /api/webhook accepts only what Meta signed with the app secret, and
 * decides that before the body is parsed or any channel account is consulted.
 */

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getOne } from "../src/db/index.ts";
import { TEST_BINDINGS } from "./bindings.ts";
import { createTenantFixture, type TenantFixture } from "./helpers/tenancy.ts";
import { signWebhookBody } from "./helpers/webhook.ts";

import { webhookRequest } from "./helpers/turn.ts";

const CUSTOMER = "51900777888";

describe("webhook signature", () => {
  let tenant: TenantFixture;
  let messageId: string;
  let rawBody: string;
  let validSignature: string;

  beforeEach(async () => {
    tenant = await createTenantFixture("signature");
    messageId = `wamid-${crypto.randomUUID()}`;
    rawBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-signature",
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
      ],
    });
    validSignature = await signWebhookBody(rawBody);
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

  it("accepts a valid signature and processes the message", async () => {
    const response = await post(validSignature);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [{ phoneNumberId: tenant.phoneNumberId, status: "received" }],
    });
    expect(await inboxRows()).toBe(1);
  });

  it("refuses a request without the header", async () => {
    await expectRefused(await post(undefined));
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

  it("refuses a signature made with another secret", async () => {
    await expectRefused(
      await post(await signWebhookBody(rawBody, "someone-else")),
    );
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

  it("checks the signature before looking at the payload", async () => {
    const garbage = "not json at all";

    const unsigned = await post(undefined, garbage);
    expect(unsigned.status).toBe(401);

    const signed = await post(await signWebhookBody(garbage), garbage);
    expect(signed.status).toBe(400);
    expect(await signed.json()).toEqual({ error: "invalid_payload" });
  });

  describe("when WHATSAPP_APP_SECRET is unset", () => {
    beforeEach(() => {
      env.WHATSAPP_APP_SECRET = "";
    });

    afterEach(() => {
      env.WHATSAPP_APP_SECRET = TEST_BINDINGS.WHATSAPP_APP_SECRET;
    });

    it("answers 503 even for a signature that would have matched", async () => {
      const response = await post(validSignature);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "webhook_not_configured",
      });
      expect(await inboxRows()).toBe(0);
    });
  });

  it("leaves the GET verification handshake unsigned", async () => {
    const response = await webhookRequest(
      `/?hub.mode=subscribe&hub.verify_token=${TEST_BINDINGS.WHATSAPP_WEBHOOK_VERIFY_TOKEN}&hub.challenge=abc123`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc123");
  });
});
