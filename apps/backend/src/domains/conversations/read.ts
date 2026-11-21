import type {
  Conversation,
  ConversationStatus,
  ReplayData,
  ReplayMetadata,
} from "@vendeya/types";
import { WhatsAppService } from "../../adapters/whatsapp/index.ts";
import { refOf } from "../../conversation/store.ts";
import { db, tenantScope } from "../../db/index.ts";
import { logAction } from "../../platform/audit/logger.ts";
import {
  assignedAgentScope,
  type AuthScope,
} from "../../platform/auth/scope.ts";

/**
 * The conversations `scope` may see, each with the name of the business's
 * customer who has its phone number. A sales agent reaches a conversation
 * assigned to them or to nobody, never one assigned to another agent. Nothing
 * assigns conversations yet, so an agent who follows an escalation alert must
 * still reach the unassigned conversation.
 */
function visibleConversations(scope: AuthScope) {
  const agent = assignedAgentScope(scope);
  return db
    .selectFrom("conversations as cv")
    .selectAll("cv")
    .select((eb) =>
      eb
        .selectFrom("customers as c")
        .select("c.name")
        .whereRef("c.tenant_id", "=", "cv.tenant_id")
        .whereRef("c.phone", "=", "cv.phone_number")
        .limit(1)
        .as("customer_name"),
    )
    .where(tenantScope(scope.tenantId, "cv.tenant_id"))
    .$if(Boolean(agent), (q) =>
      q.where((eb) =>
        eb.or([
          eb("cv.assigned_agent", "=", agent!),
          eb("cv.assigned_agent", "is", null),
        ]),
      ),
    );
}

/** Every tenant role may list conversations; `visibleConversations` says which. */
export async function listConversations(
  scope: AuthScope,
  status: ConversationStatus | undefined,
): Promise<Conversation[]> {
  return (await visibleConversations(scope)
    .where("cv.is_simulation", "=", 0)
    .$if(Boolean(status), (q) => q.where("cv.status", "=", status!))
    .orderBy("cv.last_activity_at", "desc")
    .limit(100)
    .execute()) as Conversation[];
}

/**
 * A `:phone` can match two conversations of one tenant, one per WhatsApp
 * number. Picking the latest would splice two threads, so `ambiguous` makes the
 * caller name the channel account.
 */
export type ConversationLookup =
  | { status: "found"; conversation: Conversation }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: Conversation[] };

/**
 * Resolve a conversation the caller is allowed to see. One in another tenant,
 * or assigned to another agent, is reported as not found, so every route that
 * resolves `:phone` applies the rule. An unpinned platform operator can find a
 * conversation in any open tenant.
 */
export async function lookupConversation(
  scope: AuthScope,
  phoneNumber: string,
  channelAccountId: string | null,
): Promise<ConversationLookup> {
  // Neither pinned to a tenant nor platform staff: nothing is visible.
  if (!scope.tenantId && !scope.isPlatformOperator) {
    return { status: "not_found" };
  }

  const matches = (await visibleConversations(scope)
    .where("cv.phone_number", "=", phoneNumber)
    .$if(Boolean(channelAccountId), (q) =>
      q.where("cv.channel_account_id", "=", channelAccountId!),
    )
    .orderBy("cv.last_activity_at", "desc")
    .execute()) as Conversation[];

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous", candidates: matches };
  return { status: "found", conversation: matches[0]! };
}

export async function getConversationDetail(conv: Conversation) {
  const ref = refOf(conv);
  const messages = await WhatsAppService.getMessageHistory(ref, 100);

  return {
    conversation: conv,
    messages: messages.reverse(),
  };
}

export async function getReplayData(
  conv: Conversation,
  userId: string,
): Promise<ReplayData | null> {
  const ref = refOf(conv);
  const messages = await WhatsAppService.getMessageHistory(ref, 1000);

  const metadata: ReplayMetadata = {
    conversationId: conv.phone_number,
    customerName: conv.customer_name,
    messageCount: messages.length,
    timestamp: new Date().toISOString(),
  };

  await logAction(
    { userId, tenantId: conv.tenant_id },
    "export_replay",
    "conversation",
    conv.phone_number,
  );

  return {
    conversation: conv,
    messages: messages.reverse(),
    metadata,
  };
}
