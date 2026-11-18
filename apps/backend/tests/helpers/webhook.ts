import { encodeHexLowerCase } from "@oslojs/encoding";
import { TEST_APP_SECRET } from "./tenancy.ts";

/** The `X-Hub-Signature-256` value Meta would send for this raw body. */
export async function signWebhookBody(
  rawBody: string,
  secret: string = TEST_APP_SECRET,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return `sha256=${encodeHexLowerCase(new Uint8Array(digest))}`;
}

/** Init for a POST to the webhook: a JSON body carrying a valid signature. */
export async function signedWebhookRequest(
  body: unknown,
): Promise<RequestInit> {
  const rawBody = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": await signWebhookBody(rawBody),
    },
    body: rawBody,
  };
}

/** The body Meta posts for one inbound message to `phoneNumberId`. */
export function inboundMessage(
  phoneNumberId: string,
  message: Record<string, unknown>,
) {
  return {
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
                phone_number_id: phoneNumberId,
              },
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

/** The body Meta posts for one inbound text message to `phoneNumberId`. */
export function inboundText(
  phoneNumberId: string,
  from: string,
  text: string,
  options: { id?: string; sentAt?: number } = {},
) {
  return inboundMessage(phoneNumberId, {
    from,
    id: options.id ?? `wamid-${crypto.randomUUID()}`,
    timestamp: String(Math.floor((options.sentAt ?? Date.now()) / 1000)),
    type: "text",
    text: { body: text },
  });
}

/**
 * A body of `totalBytes` spaces that arrives in `chunkBytes` pieces with no
 * Content-Length. `pulledBytes()` reports how much the reader has taken so far.
 */
export function chunkedSpaces(totalBytes: number, chunkBytes = 64 * 1024) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - pulled);
      controller.enqueue(new Uint8Array(size).fill(0x20));
      pulled += size;
    },
  });
  return { stream, pulledBytes: () => pulled, chunkBytes };
}
