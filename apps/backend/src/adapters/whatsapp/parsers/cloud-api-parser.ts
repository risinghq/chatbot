import type {
  IncomingMessage,
  InboundMessageType,
  QuotedMessageContext,
} from "@vendeya/types";

function mapCloudApiType(cloudApiType: string): InboundMessageType {
  switch (cloudApiType) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "document":
      return "document";
    case "audio":
      return "audio";
    case "video":
      return "video";
    case "location":
      return "location";
    default:
      return "unknown";
  }
}

/**
 * The text a staff member and the assistant read for a message. Media is not
 * downloaded, so an attachment is named in brackets with its caption: the
 * assistant cannot see it and has to say so.
 */
function bodyOf(webhookMessage: any, type: InboundMessageType): string {
  const captioned = (label: string, caption?: string) =>
    caption?.trim() ? `[${label}] ${caption.trim()}` : `[${label}]`;
  switch (type) {
    case "text":
      return webhookMessage.text?.body || "";
    case "image":
      return captioned("Foto", webhookMessage.image?.caption);
    case "video":
      return captioned("Video", webhookMessage.video?.caption);
    case "audio":
      return "[Nota de voz]";
    case "document": {
      const name = webhookMessage.document?.filename;
      return captioned(
        name ? `Documento: ${name}` : "Documento",
        webhookMessage.document?.caption,
      );
    }
    case "location": {
      const { latitude, longitude, name, address } =
        webhookMessage.location ?? {};
      const place = [name, address].filter(Boolean).join(", ");
      const map = `https://maps.google.com/?q=${latitude},${longitude}`;
      return `[Ubicación${place ? `: ${place}` : ""}] ${map}`;
    }
    default:
      return "";
  }
}

export function parseIncomingMessage(webhookMessage: any): IncomingMessage {
  let quotedContext: QuotedMessageContext | undefined;

  if (webhookMessage.context?.id) {
    quotedContext = {
      id: webhookMessage.context.id,
      body: "",
      type: "text",
      timestamp: 0,
    };
  }

  const type = mapCloudApiType(webhookMessage.type);
  return {
    id: webhookMessage.id,
    from: webhookMessage.from,
    body: bodyOf(webhookMessage, type),
    type,
    timestamp:
      (webhookMessage.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    quotedContext,
  };
}

/** Which of our numbers the message arrived on, and under which WABA. */
export type InboundRouting = {
  /** Meta's `metadata.phone_number_id`, the account key we route on. */
  phoneNumberId: string | null;
  /** Human-readable number. Routing does not use it. */
  displayPhoneNumber: string | null;
  /** `entry[].id` is the WhatsApp Business Account id. */
  wabaId: string | null;
};

/** One `entry[].changes[]` element: the number it arrived on, and its messages. */
export type ParsedChange = {
  routing: InboundRouting;
  /** Empty for a change that carried no messages (status callbacks, echoes). */
  messages: IncomingMessage[];
};

/**
 * Flattens a Cloud API webhook body into its changes. The entries, the changes
 * and the messages are each arrays, because one POST can batch several WhatsApp
 * Business Accounts and numbers. Reading only the first message would drop the
 * rest while still answering 200, and Meta would not redeliver them.
 */
export function parseWebhookBody(body: any): ParsedChange[] {
  const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];

  return entries.flatMap((entry) => {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];

    return changes.map((change): ParsedChange => {
      const value = change?.value;
      const messages: any[] = Array.isArray(value?.messages)
        ? value.messages
        : [];

      return {
        // Routing is returned even for a change with no messages, so callers
        // can log deliveries from numbers we do not know about.
        routing: {
          phoneNumberId: value?.metadata?.phone_number_id ?? null,
          displayPhoneNumber: value?.metadata?.display_phone_number ?? null,
          wabaId: entry?.id ?? null,
        },
        messages: messages.map(parseIncomingMessage),
      };
    });
  });
}
