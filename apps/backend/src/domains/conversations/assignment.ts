import { conversationStub } from "../../conversation/stub.ts";
import { findConversation, handOff } from "../../conversation/store.ts";
import { CustomerService } from "../customers/index.ts";
import { createLogger } from "../../lib/logger.ts";
import { eventBus, createEvent } from "../../shared/events/index.ts";
import { TenantSettings } from "../settings/system.ts";
import type { ConversationRef } from "@vendeya/types";
import { db, inActiveChannelAccounts, inOpenTenants } from "../../db/index.ts";

const logger = createLogger("assignment");

const AGENT_INDEX_KEY = "last_agent_index";

const ACCEPT_WINDOW_MS = 5 * 60 * 1000;

/**
 * A reassignment is a call into the conversation's object, one subrequest
 * each inside the sweep's invocation, which shares the subrequest budget
 * `MAX_WAKES_PER_SWEEP` in sweep.ts is sized against. Past this bound the
 * rest stay timed out for the next minute's sweep.
 */
const MAX_REASSIGNS_PER_SWEEP = 1_000;

const ASSIGNED_REASON = "agent_assigned";

/**
 * Round-robin over the agents of one tenant. The caller holds the conversation
 * lock. The conversation ends up escalated, so the bot stays silent, and
 * assigned when an agent is available. Returns null, leaving it escalated and
 * unassigned, when none is.
 */
export async function assignNextAgentHeld(
  ref: ConversationRef,
): Promise<string | null> {
  const conversation = await findConversation(ref);
  if (!conversation) return null;

  // Whoever gives up a conversation, or a turn that escalates it, is asking for
  // a person. That holds when no agent is free, so the bot must stay silent
  // either way. A held conversation keeps its own reason.
  if (conversation.status !== "human_takeover") {
    await handOff(ref, conversation.handover_reason ?? ASSIGNED_REASON);
  }

  // Agents are found through membership, so a sales agent in tenant A is never
  // handed tenant B's client. Availability is read from the membership too, so
  // going offline for one business leaves the agent in the other's rotation.
  const agents = await db
    .selectFrom("users as u")
    .innerJoin("tenant_memberships as m", "m.user_id", "u.id")
    .select(["u.id", "u.phone_number"])
    .where("m.tenant_id", "=", ref.tenantId)
    .where("m.role", "=", "sales_agent")
    .where("m.is_available", "=", 1)
    .where("u.is_active", "=", 1)
    .orderBy("u.id")
    .execute();

  if (agents.length === 0) {
    logger.warn({ tenantId: ref.tenantId }, "No available agents");
    return null;
  }

  // The cursor is this module's own state, and the settings route refuses to
  // write it (INTERNAL_TENANT_SETTING_KEYS). It is still read defensively. A
  // non-numeric or negative value falls back to 0. Otherwise the index would
  // be NaN, which survives the modulo and is written back.
  const stored = await TenantSettings.get(ref.tenantId, AGENT_INDEX_KEY);
  const parsed = stored === null ? 0 : parseInt(stored, 10);
  const previousIndex = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  const currentIndex = (previousIndex + 1) % agents.length;

  await TenantSettings.set(
    ref.tenantId,
    AGENT_INDEX_KEY,
    currentIndex.toString(),
  );

  const assignedAgent = agents[currentIndex];

  if (!assignedAgent) {
    logger.warn(
      { tenantId: ref.tenantId, currentIndex, agentCount: agents.length },
      "Failed to get agent from index",
    );
    return null;
  }

  await db
    .updateTable("conversations")
    .set({
      assigned_agent: assignedAgent.id,
      assignment_notified_at: Date.now(),
    })
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .execute();

  if (assignedAgent.phone_number) {
    await eventBus.emit(
      createEvent(
        "agent_assigned",
        {
          phoneNumber: ref.phoneNumber,
          clientName:
            (await CustomerService.getByPhone(ref.tenantId, ref.phoneNumber))
              ?.name ?? null,
          agentId: assignedAgent.id,
          agentPhone: assignedAgent.phone_number,
        },
        { tenantId: ref.tenantId, channelAccountId: ref.channelAccountId },
      ),
    );
  }

  return assignedAgent.id;
}

/**
 * Hands conversations nobody took over to the next agent. An assignment waits
 * for the agent to take the conversation over, which clears
 * `assignment_notified_at`. The minute sweep runs it across every tenant, so it
 * takes the restriction the scope-driven reads take. A suspended business must
 * not keep churning assignments and notifying agents. Each reassignment runs in
 * the conversation's object, under its lock.
 */
export async function checkAndReassignTimeouts(
  now: number = Date.now(),
  maxReassigns: number = MAX_REASSIGNS_PER_SWEEP,
): Promise<void> {
  const cutoff = now - ACCEPT_WINDOW_MS;

  // A conversation on a number that is not active is left alone, as the queues
  // leave its messages. Nobody can answer the customer there, so reassigning
  // every five minutes would only page agents for nothing. Its assignment
  // stands until the number is back.
  const timedOutConversations = await db
    .selectFrom("conversations")
    .select(["tenant_id", "channel_account_id", "phone_number"])
    .where("assignment_notified_at", "is not", null)
    .where("assignment_notified_at", "<", cutoff)
    .where("status", "=", "human_takeover")
    .where(inOpenTenants)
    .where((eb) =>
      inActiveChannelAccounts(
        eb,
        "channel_account_id",
        "conversations.tenant_id",
      ),
    )
    .orderBy("assignment_notified_at")
    .limit(maxReassigns)
    .execute();

  await Promise.all(
    timedOutConversations.map(async (conv) => {
      const ref: ConversationRef = {
        tenantId: conv.tenant_id,
        channelAccountId: conv.channel_account_id,
        phoneNumber: conv.phone_number,
      };

      try {
        const result = await conversationStub(ref).reassign(ref, cutoff);
        if (result.busy) {
          logger.debug(
            { tenantId: ref.tenantId, phoneNumber: ref.phoneNumber },
            "Conversation busy; left the reassignment for later",
          );
        }
      } catch (error) {
        logger.error(
          { error, tenantId: ref.tenantId, phoneNumber: ref.phoneNumber },
          "Reassigning a timed-out conversation failed",
        );
      }
    }),
  );
}

/** The caller holds the conversation lock. */
export async function reassignIfStillWaiting(
  ref: ConversationRef,
  cutoff: number,
): Promise<void> {
  const current = await db
    .selectFrom("conversations")
    .select("assigned_agent")
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .where("assignment_notified_at", "is not", null)
    .where("assignment_notified_at", "<", cutoff)
    .where("status", "=", "human_takeover")
    .executeTakeFirst();
  if (!current) return;

  logger.info(
    {
      tenantId: ref.tenantId,
      phoneNumber: ref.phoneNumber,
      previousAgent: current.assigned_agent,
    },
    "Reassigning timed-out conversation",
  );

  await db
    .updateTable("conversations")
    .set({ assignment_notified_at: null, assigned_agent: null })
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .execute();

  await assignNextAgentHeld(ref);
}
