import type {
  ChannelAccount,
  CommentReplySettings,
  ConversationRef,
} from "@vendeya/types";
import type { Selectable } from "kysely";
import { InstagramAdapter } from "../../adapters/instagram/api.ts";
import { WhatsAppService } from "../../adapters/whatsapp/index.ts";
import { ensureConversation } from "../../conversation/store.ts";
import { batch, db, tenantScope } from "../../db/index.ts";
import type { InstagramCommentsTable } from "../../db/schema.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger("instagram-comments");

type InstagramReplyStatus =
  Selectable<InstagramCommentsTable>["public_reply_status"];

export const DEFAULT_COMMENT_REPLY_SETTINGS: CommentReplySettings = {
  enabled: true,
  public_text:
    "¡Gracias por tu comentario! Te escribimos por mensaje directo 📩",
  private_text:
    "¡Hola! Vimos tu comentario. ¿Qué producto te interesa? Te ayudamos por aquí.",
};

/** Meta caps a comment reply and a DM well above this. */
export const COMMENT_REPLY_MAX_LENGTH = 1000;

const KEYS = {
  enabled: "ig_comment_reply_enabled",
  public_text: "ig_comment_public_text",
  private_text: "ig_comment_private_text",
} as const;

export async function getCommentReplySettings(
  tenantId: string,
): Promise<CommentReplySettings> {
  const rows = await db
    .selectFrom("tenant_settings")
    .select(["key", "value"])
    .where(tenantScope(tenantId))
    .where("key", "in", Object.values(KEYS))
    .execute();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    enabled:
      s[KEYS.enabled] === undefined
        ? DEFAULT_COMMENT_REPLY_SETTINGS.enabled
        : s[KEYS.enabled] === "1",
    public_text:
      s[KEYS.public_text] ?? DEFAULT_COMMENT_REPLY_SETTINGS.public_text,
    private_text:
      s[KEYS.private_text] ?? DEFAULT_COMMENT_REPLY_SETTINGS.private_text,
  };
}

/** The settings in a request body, or the reason they are refused. */
export function parseCommentReplySettings(
  body: Record<string, unknown>,
): CommentReplySettings | string {
  const { enabled, public_text, private_text } = body;
  if (typeof enabled !== "boolean") return "enabled must be a boolean";
  for (const [name, value] of [
    ["public_text", public_text],
    ["private_text", private_text],
  ] as const) {
    if (typeof value !== "string") return `${name} must be a string`;
    if (value.length > COMMENT_REPLY_MAX_LENGTH) {
      return `${name} must be at most ${COMMENT_REPLY_MAX_LENGTH} characters`;
    }
  }
  return {
    enabled,
    public_text: (public_text as string).trim(),
    private_text: (private_text as string).trim(),
  };
}

export async function saveCommentReplySettings(
  tenantId: string,
  settings: CommentReplySettings,
): Promise<void> {
  const now = Date.now();
  const entries: [string, string][] = [
    [KEYS.enabled, settings.enabled ? "1" : "0"],
    [KEYS.public_text, settings.public_text],
    [KEYS.private_text, settings.private_text],
  ];
  await batch(
    entries.map(([key, value]) =>
      db
        .insertInto("tenant_settings")
        .values({ tenant_id: tenantId, key, value, updated_at: now })
        .onConflict((oc) =>
          oc
            .columns(["tenant_id", "key"])
            .doUpdateSet({ value, updated_at: now }),
        ),
    ),
  );
}

/** A comment as Instagram's `comments` webhook field reports it. */
export type InstagramComment = {
  id: string;
  text: string;
  fromId: string;
  fromUsername: string | null;
  mediaId: string | null;
  parentId: string | null;
};

/**
 * Records a comment once and says whether it wants replies. The comment id is
 * the key, so Meta's redelivery of a batch claims nothing twice. The account's
 * own comments and replies inside a thread get no answer.
 */
export async function claimComment(
  account: ChannelAccount,
  comment: InstagramComment,
): Promise<"claimed" | "duplicate" | "ignored"> {
  if (comment.fromId === account.phone_number_id || comment.parentId) {
    return "ignored";
  }
  const settings = await getCommentReplySettings(account.tenant_id);
  const initial: InstagramReplyStatus = settings.enabled
    ? "pending"
    : "skipped";
  const result = await db
    .insertInto("instagram_comments")
    .values({
      comment_id: comment.id,
      tenant_id: account.tenant_id,
      channel_account_id: account.id,
      media_id: comment.mediaId,
      from_id: comment.fromId,
      from_username: comment.fromUsername,
      text: comment.text,
      public_reply_status: initial,
      private_reply_status: initial,
    })
    .onConflict((oc) => oc.column("comment_id").doNothing())
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0) === 0) return "duplicate";
  return settings.enabled ? "claimed" : "ignored";
}

async function setStatus(
  account: ChannelAccount,
  commentId: string,
  column: "public_reply_status" | "private_reply_status",
  status: InstagramReplyStatus,
): Promise<void> {
  await db
    .updateTable("instagram_comments")
    .set(column, status)
    .where(tenantScope(account.tenant_id))
    .where("comment_id", "=", commentId)
    .execute();
}

/**
 * Answers a claimed comment under the post, then in a DM to the commenter.
 * The DM lands in the inbox as the start of the commenter's conversation, and
 * their answer opens the messaging window the bot replies in. Meta allows one
 * of each per comment, so a failure is recorded, not retried.
 */
export async function replyToComment(
  account: ChannelAccount,
  comment: InstagramComment,
): Promise<void> {
  const settings = await getCommentReplySettings(account.tenant_id);

  if (settings.public_text) {
    const sent = await InstagramAdapter.replyToComment(
      account,
      comment.id,
      settings.public_text,
    );
    await setStatus(
      account,
      comment.id,
      "public_reply_status",
      sent.ok ? "sent" : "failed",
    );
    if (!sent.ok) {
      logger.warn(
        { channelAccountId: account.id, reason: sent.reason },
        "Public comment reply failed",
      );
    }
  } else {
    await setStatus(account, comment.id, "public_reply_status", "skipped");
  }

  if (!settings.private_text) {
    await setStatus(account, comment.id, "private_reply_status", "skipped");
    return;
  }
  const sent = await InstagramAdapter.privateReply(
    account,
    comment.id,
    settings.private_text,
  );
  await setStatus(
    account,
    comment.id,
    "private_reply_status",
    sent.ok ? "sent" : "failed",
  );
  if (!sent.ok) {
    logger.warn(
      { channelAccountId: account.id, reason: sent.reason },
      "Private comment reply failed",
    );
    return;
  }
  const ref: ConversationRef = {
    tenantId: account.tenant_id,
    channelAccountId: account.id,
    phoneNumber: comment.fromId,
  };
  await ensureConversation(ref);
  await WhatsAppService.logMessage(
    ref,
    "outbound",
    "text",
    settings.private_text,
  );
}
