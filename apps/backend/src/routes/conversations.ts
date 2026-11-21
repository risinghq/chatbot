import { Hono } from "hono";
import { pathParam } from "../lib/http.ts";
import type { Context } from "hono";
import {
  CONVERSATION_STATUSES,
  type Conversation,
  type ConversationStatus,
} from "@vendeya/types";
import * as ConversationRead from "../domains/conversations/read.ts";
import { ConversationBusyError } from "../conversation/locks.ts";
import { refOf } from "../conversation/store.ts";
import * as ConversationWrite from "../domains/conversations/write.ts";
import { requireActiveTenant, requireTenantScope } from "../middleware/auth.ts";

const conversations = new Hono();

// Reads span tenants for a platform operator who has not pinned one. Writes
// also take `requireActiveTenant`, because a write must land in a tenant the
// caller has selected.
conversations.use("/*", requireTenantScope);

/**
 * Resolves `:phone` within the caller's scope: the pinned tenant, or every open
 * tenant for an unpinned platform operator. A conversation outside that scope
 * is indistinguishable from one that does not exist.
 */
async function resolve(
  c: Context,
): Promise<{ conversation: Conversation } | { error: Response }> {
  const lookup = await ConversationRead.lookupConversation(
    c.get("scope"),
    pathParam(c, "phone"),
    c.req.query("channel") ?? null,
  );

  if (lookup.status === "found") {
    return { conversation: lookup.conversation };
  }

  // The same contact can talk to two numbers in scope. `?channel=` picks the
  // thread. Without it the request is refused instead of answered with
  // whichever thread was touched last.
  if (lookup.status === "ambiguous") {
    return {
      error: c.json(
        {
          error: "Ambiguous conversation",
          detail:
            "This contact is talking to more than one of your numbers; pass ?channel=<channel_account_id>",
          channels: lookup.candidates.map((conv) => ({
            channelAccountId: conv.channel_account_id,
            lastActivityAt: conv.last_activity_at,
          })),
        },
        409,
      ),
    };
  }

  return { error: c.json({ error: "Conversation not found" }, 404) };
}

/**
 * A lock wait that runs out is answered as busy. After a timed-out write the
 * change may still land, and repeating a takeover or a release is harmless.
 */
function refuseIfBusy(c: Context, error: unknown): Response {
  if (error instanceof ConversationBusyError) {
    return c.json(
      { error: "The conversation is busy. Try again in a moment." },
      409,
    );
  }
  throw error;
}

conversations.get("/", async (c) => {
  const scope = c.get("scope");
  const status = c.req.query("status") as ConversationStatus | undefined;
  if (status && !CONVERSATION_STATUSES.includes(status)) {
    return c.json({ error: "Unknown status" }, 400);
  }

  const rows = await ConversationRead.listConversations(scope, status);
  return c.json(rows);
});

conversations.get("/:phone", async (c) => {
  const found = await resolve(c);
  if ("error" in found) return found.error;

  return c.json(
    await ConversationRead.getConversationDetail(found.conversation),
  );
});

conversations.post("/:phone/takeover", requireActiveTenant, async (c) => {
  const found = await resolve(c);
  if ("error" in found) return found.error;
  const conv = found.conversation;

  const user = c.get("user");

  try {
    const result = await ConversationWrite.takeoverConversation(
      refOf(conv),
      user.id,
    );
    if (!result.success) {
      return c.json({ error: result.error }, 409);
    }
    return c.json(result);
  } catch (error) {
    return refuseIfBusy(c, error);
  }
});

conversations.post("/:phone/message", requireActiveTenant, async (c) => {
  const found = await resolve(c);
  if ("error" in found) return found.error;
  const conv = found.conversation;

  const { content } = await c.req.json();
  const user = c.get("user");

  const result = await ConversationWrite.sendManualMessage(
    refOf(conv),
    content,
    user.id,
  );

  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }

  return c.json(result);
});

conversations.post("/:phone/release", requireActiveTenant, async (c) => {
  const found = await resolve(c);
  if ("error" in found) return found.error;
  const conv = found.conversation;

  const user = c.get("user");

  try {
    const result = await ConversationWrite.releaseConversation(
      refOf(conv),
      user.id,
    );
    return c.json(result);
  } catch (error) {
    return refuseIfBusy(c, error);
  }
});

conversations.post(
  "/:phone/decline-assignment",
  requireActiveTenant,
  async (c) => {
    const found = await resolve(c);
    if ("error" in found) return found.error;
    const conv = found.conversation;

    const user = c.get("user");

    try {
      const result = await ConversationWrite.declineAssignment(
        refOf(conv),
        user.id,
      );

      if (!result.success) {
        return c.json({ error: result.error }, 403);
      }

      return c.json({ success: true });
    } catch (error) {
      return refuseIfBusy(c, error);
    }
  },
);

conversations.get("/:phone/replay", async (c) => {
  const user = c.get("user");

  if (user.role !== "admin" && user.role !== "developer") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const found = await resolve(c);
  if ("error" in found) return found.error;
  const conv = found.conversation;

  const replayData = await ConversationRead.getReplayData(conv, user.id);

  if (!replayData) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json(replayData);
});

export default conversations;
