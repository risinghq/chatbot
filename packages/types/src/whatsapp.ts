/** The types `messages.type` can hold. */
export type StoredMessageType = "text" | "image" | "template";

/** What a channel can deliver. Only the stored types are kept in `messages`. */
export type InboundMessageType =
  | StoredMessageType
  | "document"
  | "audio"
  | "video"
  | "location"
  | "unknown";

export type QuotedMessageContext = {
  id: string;
  body: string;
  type: InboundMessageType;
  timestamp: number;
};

/** The ad a click-to-WhatsApp message came from, as Meta's `referral` gives it. */
export type AdReferral = {
  /** Meta's ad id, `referral.source_id`. */
  sourceId: string;
  headline: string | null;
  ctwaClid: string | null;
};

export type IncomingMessage = {
  id: string;
  from: string;
  body: string;
  type: InboundMessageType;
  timestamp: number;
  quotedContext?: QuotedMessageContext;
  /** Set when the message arrived from a click-to-WhatsApp ad. */
  referral?: AdReferral;
};
