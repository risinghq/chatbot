import type { ChannelAccount } from "@vendeya/types";
import { publicOrigin } from "../../config.ts";
import { instagramGraphUrl } from "../../config/graph.ts";
import { createAbortTimeout, TIMEOUTS } from "../../config/timeouts.ts";
import { postSend, sendingToken } from "../whatsapp/cloud-api.ts";
import type { OutboundMessage, SendOutcome } from "../whatsapp/types.ts";

/**
 * Where a send falls in Instagram's messaging window. Inside 24 hours of the
 * customer's last message anything may be sent. Up to 7 days, only a person's
 * reply, tagged `HUMAN_AGENT`.
 */
export type InstagramWindow = "open" | "human_agent";

function idOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message_id?: unknown; id?: unknown };
    const id = parsed.message_id ?? parsed.id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

async function postAs(
  account: ChannelAccount,
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<SendOutcome> {
  const token = await sendingToken(account);
  if ("refusal" in token) {
    return { ok: false, kind: "permanent", reason: token.refusal };
  }
  return postSend(
    { url: instagramGraphUrl(path), token: token.token },
    payload,
    timeoutMs,
    idOf,
  );
}

function windowFields(window: InstagramWindow): Record<string, unknown> {
  return window === "human_agent"
    ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
    : {};
}

function dm(
  account: ChannelAccount,
  to: string,
  message: Record<string, unknown>,
  window: InstagramWindow,
  timeoutMs: number,
): Promise<SendOutcome> {
  return postAs(
    account,
    `${account.phone_number_id}/messages`,
    { recipient: { id: to }, message, ...windowFields(window) },
    timeoutMs,
  );
}

/**
 * Instagram API with Instagram Login. The account's `phone_number_id` holds
 * its professional account id, and a contact is their Instagram-scoped id.
 */
export const InstagramAdapter = {
  /**
   * Instagram has no message templates, so a template is refused. An image
   * carries no caption on Instagram: the caption follows as its own message.
   */
  async send(
    account: ChannelAccount,
    to: string,
    message: OutboundMessage,
    window: InstagramWindow,
  ): Promise<SendOutcome> {
    if (message.type === "template") {
      return { ok: false, kind: "permanent", reason: "instagram_no_templates" };
    }
    if (message.type === "text") {
      return dm(
        account,
        to,
        { text: message.content },
        window,
        TIMEOUTS.WHATSAPP_SEND,
      );
    }

    const url = `${publicOrigin()}/media/${message.content}`;
    const image = await dm(
      account,
      to,
      { attachment: { type: "image", payload: { url } } },
      window,
      TIMEOUTS.WHATSAPP_IMAGE,
    );
    if (image.ok && message.caption) {
      await dm(
        account,
        to,
        { text: message.caption },
        window,
        TIMEOUTS.WHATSAPP_SEND,
      );
    }
    return image;
  },

  /** Answers a comment in public, under the post. Meta allows one per comment. */
  replyToComment(
    account: ChannelAccount,
    commentId: string,
    text: string,
  ): Promise<SendOutcome> {
    return postAs(
      account,
      `${commentId}/replies`,
      { message: text },
      TIMEOUTS.WHATSAPP_SEND,
    );
  },

  /**
   * Opens a DM with the commenter. Meta allows one per comment, within 7 days
   * of it; the commenter's reply opens the normal window.
   */
  privateReply(
    account: ChannelAccount,
    commentId: string,
    text: string,
  ): Promise<SendOutcome> {
    return postAs(
      account,
      `${account.phone_number_id}/messages`,
      { recipient: { comment_id: commentId }, message: { text } },
      TIMEOUTS.WHATSAPP_SEND,
    );
  },

  /** Marks the conversation seen and shows typing. Failures are ignored. */
  async markSeen(
    account: ChannelAccount,
    to: string,
    { typing }: { typing: boolean },
  ): Promise<void> {
    const token = await sendingToken(account);
    if ("refusal" in token) return;
    const actions = typing ? ["mark_seen", "typing_on"] : ["mark_seen"];
    for (const action of actions) {
      const { signal, cleanup } = createAbortTimeout(5_000);
      try {
        await fetch(instagramGraphUrl(`${account.phone_number_id}/messages`), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            recipient: { id: to },
            sender_action: action,
          }),
          signal,
        });
      } catch {
        // A read receipt that does not arrive changes nothing.
      } finally {
        cleanup();
      }
    }
  },
};
