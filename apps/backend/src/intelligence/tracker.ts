import { newId } from "@vendeya/utils";
import { sql } from "kysely";
import type { ConversationRef } from "@vendeya/types";
import { createLogger } from "../lib/logger.ts";
import { db, tenantScope } from "../db/index.ts";

const logger = createLogger("llm-tracker");

export type LLMCallData = {
  ref: ConversationRef;
  operation: string;
  model: string;
  prompt: string;
  userMessage: string;
  response?: string;
  status: "success" | "error";
  errorType?: string;
  errorMessage?: string;
  latencyMs: number;
  tokensPrompt?: number;
  tokensCompletion?: number;
  tokensTotal?: number;
  contextMetadata?: Record<string, any>;
};

/** Never throws: a lost cost row must not fail the turn that made the call. */
export async function trackLLMCall(data: LLMCallData): Promise<void> {
  try {
    await _trackLLMCallAsync(data);
  } catch (err) {
    logger.error(
      { err, operation: data.operation },
      "Failed to track LLM call",
    );
  }
}

async function _trackLLMCallAsync(data: LLMCallData): Promise<void> {
  const contextJson = data.contextMetadata
    ? JSON.stringify(data.contextMetadata)
    : null;

  await db
    .insertInto("llm_calls")
    .values({
      id: newId(),
      tenant_id: data.ref.tenantId,
      channel_account_id: data.ref.channelAccountId,
      phone_number: data.ref.phoneNumber,
      operation: data.operation,
      model: data.model,
      prompt: data.prompt,
      user_message: data.userMessage,
      response: data.response || null,
      status: data.status,
      error_type: data.errorType || null,
      error_message: data.errorMessage || null,
      latency_ms: data.latencyMs,
      tokens_prompt: data.tokensPrompt || null,
      tokens_completion: data.tokensCompletion || null,
      tokens_total: data.tokensTotal || null,
      context_metadata: contextJson,
    })
    .execute();
}

/** `tenantId` null spans tenants and is only reachable by platform operators. */
export async function getRecentLLMCalls(
  tenantId: string | null,
  limit: number = 50,
) {
  return await db
    .selectFrom("llm_calls")
    .selectAll()
    .where(tenantScope(tenantId))
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
}

/**
 * Get error rate and performance stats by operation
 */
export async function getLLMErrorStats(
  tenantId: string | null,
  hoursBack: number = 24,
) {
  return await db
    .selectFrom("llm_calls")
    .select((eb) => [
      "operation",
      eb.fn.countAll<number>().as("total_calls"),
      sql<number>`sum(case when status = 'error' then 1 else 0 end)`.as(
        "error_count",
      ),
      sql<number>`round(avg(latency_ms), 2)`.as("avg_latency_ms"),
    ])
    .where(
      sql<boolean>`created_at > datetime('now', '-' || ${hoursBack} || ' hours')`,
    )
    .where(tenantScope(tenantId))
    .groupBy("operation")
    .orderBy("total_calls", "desc")
    .execute();
}
