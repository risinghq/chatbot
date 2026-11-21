import { newId } from "@vendeya/utils";
import { tenantPredicate } from "../db/query.ts";
import type { Binding } from "../db/index.ts";
import type { ConversationRef } from "@vendeya/types";
import { createLogger } from "../lib/logger.ts";
import { getAll, run } from "../db/index.ts";

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
  const id = newId();
  const contextJson = data.contextMetadata
    ? JSON.stringify(data.contextMetadata)
    : null;

  await run(
    `INSERT INTO llm_calls (
      id, tenant_id, channel_account_id, phone_number, operation, model,
      prompt, user_message, response,
      status, error_type, error_message,
      latency_ms, tokens_prompt, tokens_completion, tokens_total,
      context_metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.ref.tenantId,
      data.ref.channelAccountId,
      data.ref.phoneNumber,
      data.operation,
      data.model,
      data.prompt,
      data.userMessage,
      data.response || null,
      data.status,
      data.errorType || null,
      data.errorMessage || null,
      data.latencyMs,
      data.tokensPrompt || null,
      data.tokensCompletion || null,
      data.tokensTotal || null,
      contextJson,
    ],
  );
}

/** `tenantId` null spans tenants and is only reachable by platform operators. */
export async function getRecentLLMCalls(
  tenantId: string | null,
  limit: number = 50,
) {
  const params: Binding[] = tenantId ? [tenantId, limit] : [limit];

  return await getAll(
    `SELECT * FROM llm_calls
     WHERE ${tenantPredicate(tenantId)}
     ORDER BY created_at DESC
     LIMIT ?`,
    params,
  );
}

/**
 * Get error rate and performance stats by operation
 */
export async function getLLMErrorStats(
  tenantId: string | null,
  hoursBack: number = 24,
) {
  const conditions = ["created_at > datetime('now', '-' || ? || ' hours')"];
  const params: Binding[] = [hoursBack];

  conditions.push(tenantPredicate(tenantId));
  if (tenantId) params.push(tenantId);

  return await getAll(
    `SELECT
       operation,
       COUNT(*) as total_calls,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
       ROUND(AVG(latency_ms), 2) as avg_latency_ms
     FROM llm_calls
     WHERE ${conditions.join(" AND ")}
     GROUP BY operation
     ORDER BY total_calls DESC`,
    params,
  );
}
