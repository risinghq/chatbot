import { newId } from "@vendeya/utils";
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

export async function getRecentLLMCalls(
  tenantId: string,
  limit: number = 50,
  offset: number = 0,
) {
  return await db
    .selectFrom("llm_calls")
    .selectAll()
    .where(tenantScope(tenantId))
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}
