import type { Conversation, ConversationRef } from "@vendeya/types";
import type { ConversationPhase, ConversationMetadata } from "@vendeya/core";
import { getOne, run, stmt } from "../db/index.ts";

type ConversationData = {
  ref: ConversationRef;
  phoneNumber: string;
  phase: ConversationPhase;
  metadata: ConversationMetadata;
  isSimulation: boolean;
};

const DEFAULT_PHASE: ConversationPhase = { phase: "greeting" };

const IDENTITY_WHERE =
  "tenant_id = ? AND channel_account_id = ? AND phone_number = ?";

function identityParams(ref: ConversationRef): [string, string, string] {
  return [ref.tenantId, ref.channelAccountId, ref.phoneNumber];
}

export async function findConversation(
  ref: ConversationRef,
): Promise<Conversation | null> {
  return (
    (await getOne<Conversation>(
      `SELECT * FROM conversations WHERE ${IDENTITY_WHERE}`,
      identityParams(ref),
    )) ?? null
  );
}

export async function getOrCreateConversation(
  ref: ConversationRef,
  isSimulation = false,
): Promise<ConversationData> {
  const conv = await findConversation(ref);

  if (!conv) {
    const now = Date.now();
    const initialPhase = DEFAULT_PHASE;
    const initialMetadata: ConversationMetadata = {
      createdAt: now,
      lastActivityAt: now,
      phoneNumber: ref.phoneNumber,
    };

    await run(
      `INSERT INTO conversations (tenant_id, channel_account_id, phone_number, context_data, status, is_simulation)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        ref.tenantId,
        ref.channelAccountId,
        ref.phoneNumber,
        JSON.stringify({ phase: initialPhase, metadata: initialMetadata }),
        "active",
        isSimulation ? 1 : 0,
      ],
    );

    return {
      ref,
      phoneNumber: ref.phoneNumber,
      phase: initialPhase,
      metadata: initialMetadata,
      isSimulation,
    };
  }

  return parseConversation(conv);
}

export async function updateConversation(
  ref: ConversationRef,
  phase: ConversationPhase,
  metadata: Partial<ConversationMetadata>,
): Promise<void> {
  await (await conversationUpdate(ref, phase, metadata)).run();
}

/**
 * The statement that writes the phase and merged metadata, for a caller's
 * batch. It reads the row first, so the caller holds the conversation lock.
 */
export async function conversationUpdate(
  ref: ConversationRef,
  phase: ConversationPhase,
  metadata: Partial<ConversationMetadata>,
): Promise<D1PreparedStatement> {
  const existing = await findConversation(ref);

  if (!existing) {
    throw new Error(
      `Conversation not found: ${ref.tenantId}/${ref.channelAccountId}/${ref.phoneNumber}`,
    );
  }

  const currentMetadata = parseMetadata(existing.context_data);
  const mergedMetadata: ConversationMetadata = {
    ...currentMetadata,
    ...metadata,
    lastActivityAt: Date.now(),
  };

  const updates: Record<string, unknown> = {
    context_data: JSON.stringify({
      phase: phase,
      metadata: mergedMetadata,
    }),
    last_activity_at: Date.now(),
  };

  if (metadata.dni) updates.dni = metadata.dni;
  if (metadata.name) updates.client_name = metadata.name;
  if (metadata.segment) updates.segment = metadata.segment;
  if (metadata.credit !== undefined) updates.credit_line = metadata.credit;
  if (metadata.nse !== undefined) updates.nse = metadata.nse;
  if (metadata.age !== undefined) updates.age = metadata.age;

  if (phase.phase === "escalated") {
    updates.status = "human_takeover";
    updates.handover_reason = phase.reason;
  }

  const fields = Object.keys(updates)
    .map((k) => `${k} = ?`)
    .join(", ");
  const values = [...Object.values(updates), ...identityParams(ref)] as (
    | string
    | number
    | null
  )[];

  return stmt(
    `UPDATE conversations SET ${fields} WHERE ${IDENTITY_WHERE}`,
    values,
  );
}

export async function escalateConversation(
  ref: ConversationRef,
  reason: string,
): Promise<void> {
  await updateConversation(ref, { phase: "escalated", reason }, {});
}

/**
 * Writes neither the phase nor the status, so it needs no lock. A row without
 * valid JSON in `context_data` is left as it is, because `json_set` on NULL
 * returns NULL and would wipe the column.
 */
export async function refreshLastActivity(ref: ConversationRef): Promise<void> {
  await activityUpdate(ref).run();
}

/** `refreshLastActivity` as a statement, for a caller's batch. */
export function activityUpdate(ref: ConversationRef): D1PreparedStatement {
  const now = Date.now();
  return stmt(
    `UPDATE conversations
     SET context_data = json_set(context_data, '$.metadata.lastActivityAt', ?),
         last_activity_at = ?
     WHERE ${IDENTITY_WHERE} AND json_valid(context_data)`,
    [now, now, ...identityParams(ref)],
  );
}

export function isSessionTimedOut(metadata: ConversationMetadata): boolean {
  const hoursSince = (Date.now() - metadata.lastActivityAt) / (1000 * 60 * 60);
  return hoursSince >= 3;
}

/**
 * Hands the conversation back to the bot. A conversation a person had taken
 * loses its agent, because nobody holds a conversation the bot answers. An
 * agent assigned to a bot-owned conversation keeps it.
 */
export async function resetSession(
  ref: ConversationRef,
  preserveCategory?: string,
): Promise<void> {
  const now = Date.now();
  const newMetadata: ConversationMetadata = {
    isReturningUser: true,
    lastCategory: preserveCategory,
    createdAt: now,
    lastActivityAt: now,
  };

  // SQLite evaluates every SET expression against the row before the update,
  // so the CASE tests the status the conversation had.
  await run(
    `UPDATE conversations
     SET context_data = ?,
         assigned_agent = CASE WHEN status = 'human_takeover'
                               THEN NULL ELSE assigned_agent END,
         assignment_notified_at = CASE WHEN status = 'human_takeover'
                                       THEN NULL ELSE assignment_notified_at END,
         status = 'active',
         handover_reason = NULL,
         last_activity_at = ?
     WHERE ${IDENTITY_WHERE}`,
    [
      JSON.stringify({ phase: DEFAULT_PHASE, metadata: newMetadata }),
      now,
      ...identityParams(ref),
    ],
  );
}

export function refOf(conv: Conversation): ConversationRef {
  return {
    tenantId: conv.tenant_id,
    channelAccountId: conv.channel_account_id,
    phoneNumber: conv.phone_number,
  };
}

// --- Internal helpers ---

function parseConversation(conv: Conversation): ConversationData {
  const contextData = JSON.parse(conv.context_data || "{}");

  return {
    ref: refOf(conv),
    phoneNumber: conv.phone_number,
    phase: contextData.phase as ConversationPhase,
    metadata: {
      ...contextData.metadata,
      phoneNumber: conv.phone_number,
    } as ConversationMetadata,
    isSimulation: conv.is_simulation === 1,
  };
}

function parseMetadata(contextDataJson: string | null): ConversationMetadata {
  const contextData = JSON.parse(contextDataJson || "{}");
  if (contextData.metadata) {
    return contextData.metadata;
  }
  return {
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}
