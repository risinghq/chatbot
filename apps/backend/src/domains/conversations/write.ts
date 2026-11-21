import type { ConversationRef } from "@vendeya/types";
import type { SendOutcome } from "../../adapters/whatsapp/types.ts";
import {
  ChannelUnavailableError,
  WhatsAppService,
} from "../../adapters/whatsapp/index.ts";
import { logAction } from "../../platform/audit/logger.ts";
import { assignNextAgentHeld } from "./assignment.ts";
import { cancelPendingStatements } from "../../conversation/outbox.ts";
import { conversationStub, unlocked } from "../../conversation/stub.ts";
import { clearUnreadAlert } from "../../conversation/unread-alerts.ts";
import {
  byRef,
  findConversation,
  handOffUpdate,
  refreshLastActivity,
  release,
} from "../../conversation/store.ts";
import { batch, db } from "../../db/index.ts";

const MANUAL_TAKEOVER_REASON = "Manual takeover by agent";

export type WriteResult = { success: boolean; error?: string };

/**
 * A turn records its outcome when it ends. Without the lock a takeover that
 * lands mid-turn could be followed by the turn's hand-off or reply as if
 * nobody held the conversation. A turn already in flight may still send the replies it had ready.
 * The lock makes checking and assigning the taker atomic.
 *
 * @throws ConversationBusyError if the conversation's lock does not come free
 */
export async function takeoverConversation(
  ref: ConversationRef,
  userId: string,
): Promise<WriteResult> {
  return unlocked(ref, await conversationStub(ref).takeover(ref, userId));
}

/** The caller holds the conversation lock. */
export async function takeoverHeld(
  ref: ConversationRef,
  userId: string,
): Promise<WriteResult> {
  const current = await findConversation(ref);
  if (current?.assigned_agent && current.assigned_agent !== userId) {
    return {
      success: false,
      error: "Another agent has already taken this conversation",
    };
  }

  // One batch, so a failure cannot leave the bot silenced with nobody holding
  // the conversation. Taking the conversation over accepts an assignment, so
  // the timer that would hand it to the next agent has nothing left to wait
  // for. Replies the bot still owed are dropped, because the person now
  // answers. A bot escalation does not come through here, so the "an advisor
  // will contact you" text it queued still goes out.
  const results = await batch([
    handOffUpdate(ref, MANUAL_TAKEOVER_REASON),
    byRef(
      db
        .updateTable("conversations")
        .set({ assigned_agent: userId, assignment_notified_at: null }),
      ref,
    ),
    ...cancelPendingStatements(ref),
  ]);
  const cancelledReplies = results[results.length - 1]!.meta.changes;

  await logAction(
    { userId, tenantId: ref.tenantId },
    "takeover",
    "conversation",
    ref.phoneNumber,
    { cancelledReplies },
  );

  return { success: true };
}

/**
 * The lock keeps a turn in flight from handing the conversation off again
 * after the release.
 *
 * @throws ConversationBusyError if the conversation's lock does not come free
 */
export async function releaseConversation(
  ref: ConversationRef,
  userId: string,
): Promise<WriteResult> {
  unlocked(ref, await conversationStub(ref).release(ref, userId));
  return { success: true };
}

/**
 * The caller holds the conversation lock. The state is read again here,
 * because the row the route resolved may be stale.
 */
export async function releaseHeld(
  ref: ConversationRef,
  userId: string,
): Promise<void> {
  const row = await findConversation(ref);

  // A conversation the assistant owns is left alone, so a repeated release
  // does nothing.
  if (row?.status !== "human_takeover") return;

  await release(ref);

  await logAction(
    { userId, tenantId: ref.tenantId },
    "release",
    "conversation",
    ref.phoneNumber,
  );
}

const SEND_FAILURE_MESSAGES = {
  permanent:
    "The message could not be sent, so the customer did not receive it",
  transient:
    "WhatsApp is not accepting messages right now, so the customer did not receive it. Try again in a moment",
  ambiguous:
    "WhatsApp did not confirm the message, so it may not have reached the customer",
} as const;

export async function sendManualMessage(
  ref: ConversationRef,
  content: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!content) {
    return { success: false, error: "Message content required" };
  }

  let outcome: SendOutcome;
  try {
    outcome = await WhatsAppService.sendMessage(ref, content);
  } catch (error) {
    // The number this conversation happens on is switched off. Nothing went
    // out, so the agent is told rather than shown a message that looks sent.
    if (error instanceof ChannelUnavailableError) {
      return {
        success: false,
        error:
          "This conversation's WhatsApp number is not active, so nothing was sent",
      };
    }
    throw error;
  }

  // The message may have reached the customer, so the attempt is audited. The
  // agent still gets the failure, and nothing that depends on a confirmed
  // delivery moves.
  if (!outcome.ok) {
    if (outcome.kind === "ambiguous") {
      await logAction(
        { userId, tenantId: ref.tenantId },
        "send_message",
        "conversation",
        ref.phoneNumber,
        { message: content, deliveryUnconfirmed: true },
      );
    }
    return { success: false, error: SEND_FAILURE_MESSAGES[outcome.kind] };
  }

  // Keeps the idle reset away from a conversation an agent is answering.
  await refreshLastActivity(ref);
  await clearUnreadAlert(ref);

  await logAction(
    { userId, tenantId: ref.tenantId },
    "send_message",
    "conversation",
    ref.phoneNumber,
    { message: content },
  );

  return { success: true };
}

/**
 * The assigned agent gives the conversation up and the next agent in rotation
 * gets it. The check and the hand-over happen under the conversation lock, so a
 * decline cannot reassign a conversation the agent took over meanwhile.
 *
 * @throws ConversationBusyError if the conversation's lock does not come free
 */
export async function declineAssignment(
  ref: ConversationRef,
  userId: string,
): Promise<WriteResult> {
  return unlocked(ref, await conversationStub(ref).decline(ref, userId));
}

/** The caller holds the conversation lock. */
export async function declineHeld(
  ref: ConversationRef,
  userId: string,
): Promise<WriteResult> {
  const conv = await findConversation(ref);

  if (!conv || conv.assigned_agent !== userId) {
    return { success: false, error: "Not assigned to you" };
  }

  await byRef(
    db
      .updateTable("conversations")
      .set({ assignment_notified_at: null, assigned_agent: null }),
    ref,
  ).execute();

  await assignNextAgentHeld(ref);

  await logAction(
    { userId, tenantId: ref.tenantId },
    "decline_assignment",
    "conversation",
    ref.phoneNumber,
  );

  return { success: true };
}
