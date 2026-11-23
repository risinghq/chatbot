import type {
  AgentMessage,
  CompleteFn,
  Completion,
  ToolCall,
} from "@vendeya/intelligence";
import type { ConversationRef } from "@vendeya/types";
import { db } from "../../db/index.ts";
import { classifyLLMError } from "../../intelligence/llm-errors.ts";
import { trackLLMCall } from "../../intelligence/tracker.ts";
import { CustomerService } from "../customers/index.ts";
import { caliddaLogin } from "../settings/calidda.ts";
import { TenantService } from "../tenants/index.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { AssistantSettingsService } from "./settings.ts";
import { toWhatsAppText } from "./whatsapp-text.ts";
import {
  runTool,
  toolsFor,
  type Tool,
  type ToolContext,
  type ToolEffect,
} from "./tools/index.ts";

/** Tool calls one turn may make before the model must answer in text. */
export const MAX_TOOL_CALLS = 6;

/** The messages a turn reads: the most recent, from the last day only. */
const HISTORY_LIMIT = 30;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

const OPERATION = "assistant_reply";

export type AgentTurn = {
  /** Empty when the model wrote nothing. */
  reply: string;
  effects: ToolEffect[];
};

/**
 * The model failed mid-turn. `effects` are those of the tools that already
 * ran, which happened and must still be carried out.
 */
export class AssistantUnavailableError extends Error {
  constructor(
    readonly effects: ToolEffect[],
    cause: unknown,
  ) {
    super("The assistant model did not answer", { cause });
    this.name = "AssistantUnavailableError";
  }
}

/**
 * The conversation as the model reads it. A reply that failed to send is
 * left out because the customer never saw it.
 */
async function loadHistory(ref: ConversationRef): Promise<AgentMessage[]> {
  const rows = await db
    .selectFrom("messages")
    .select(["direction", "type", "content"])
    .where("tenant_id", "=", ref.tenantId)
    .where("channel_account_id", "=", ref.channelAccountId)
    .where("phone_number", "=", ref.phoneNumber)
    .where("created_at", ">=", Date.now() - HISTORY_WINDOW_MS)
    .where((eb) =>
      eb.or([eb("direction", "=", "inbound"), eb("status", "!=", "failed")]),
    )
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(HISTORY_LIMIT)
    .execute();

  return rows.reverse().map((row): AgentMessage => {
    if (row.direction === "inbound") {
      return {
        role: "user",
        content: row.type === "image" ? "[sent a photo]" : (row.content ?? ""),
      };
    }
    return {
      role: "assistant",
      content: row.type === "image" ? "[sent a photo]" : (row.content ?? ""),
    };
  });
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function describeResponse(completion: Completion): string {
  if (completion.toolCalls.length === 0) return completion.content ?? "";
  return JSON.stringify(
    completion.toolCalls.map((c) => ({ tool: c.name, arguments: c.arguments })),
  );
}

type Step = {
  ref: ConversationRef;
  complete: CompleteFn;
  model: string;
  messages: AgentMessage[];
  tools: readonly Tool[];
  allowTools: boolean;
  /** What this call adds to the last: the prompt, or the tool results. */
  input: string;
  customerMessage: string;
};

/** One model call, recorded in `llm_calls` whether it answers or throws. */
async function callModel(step: Step): Promise<Completion> {
  const started = Date.now();
  const row = {
    ref: step.ref,
    operation: OPERATION,
    model: step.model,
    prompt: step.input,
    userMessage: step.customerMessage,
  };
  try {
    const completion = await step.complete({
      model: step.model,
      messages: step.messages,
      tools: step.tools,
      allowTools: step.allowTools,
    });
    await trackLLMCall({
      ...row,
      response: describeResponse(completion),
      status: "success",
      latencyMs: Date.now() - started,
      tokensPrompt: completion.usage?.prompt,
      tokensCompletion: completion.usage?.completion,
      tokensTotal: completion.usage?.total,
    });
    return completion;
  } catch (error) {
    const classified = classifyLLMError(error);
    await trackLLMCall({
      ...row,
      status: "error",
      errorType: classified.type,
      errorMessage: classified.message,
      latencyMs: Date.now() - started,
    });
    throw error;
  }
}

function lastCustomerMessage(history: AgentMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.role === "user") return message.content;
  }
  return "";
}

/**
 * Works out the reply to the conversation's latest messages. Tools run as the
 * model calls them, so a write (an order) has happened by the time this
 * returns; sending the reply and carrying out the effects is the caller's.
 *
 * @throws AssistantUnavailableError when a model call fails
 */
export async function runAgent(input: {
  ref: ConversationRef;
  simulated: boolean;
  complete: CompleteFn;
  /** The earlier message the customer's latest one replies to, if any. */
  quoted?: string;
}): Promise<AgentTurn> {
  const { ref, simulated, complete, quoted } = input;
  const [settings, tenant, customer, history, calidda] = await Promise.all([
    AssistantSettingsService.get(ref.tenantId),
    TenantService.getById(ref.tenantId),
    CustomerService.getByPhone(ref.tenantId, ref.phoneNumber),
    loadHistory(ref),
    caliddaLogin(ref.tenantId),
  ]);
  const caliddaCredit = calidda !== null;
  const tools = toolsFor({ caliddaCredit });

  const system = buildSystemPrompt({
    businessName: tenant?.name ?? "the business",
    settings,
    customer,
    caliddaCredit,
    now: new Date(),
  });
  const messages: AgentMessage[] = [
    { role: "system", content: system },
    ...history,
  ];
  if (quoted) {
    messages.push({
      role: "system",
      content: `The customer's latest message replies to this earlier message: ${JSON.stringify(quoted)}`,
    });
  }
  const customerMessage = lastCustomerMessage(history);
  const ctx: ToolContext = {
    tenantId: ref.tenantId,
    channelAccountId: ref.channelAccountId,
    phone: ref.phoneNumber,
    simulated,
  };

  const effects: ToolEffect[] = [];
  let toolCalls = 0;
  let stepInput = system;

  for (;;) {
    const allowTools = toolCalls < MAX_TOOL_CALLS;
    let completion: Completion;
    try {
      completion = await callModel({
        ref,
        complete,
        model: settings.model,
        messages,
        tools,
        allowTools,
        input: stepInput,
        customerMessage,
      });
    } catch (error) {
      throw new AssistantUnavailableError(effects, error);
    }

    if (!allowTools || completion.toolCalls.length === 0) {
      return {
        reply: toWhatsAppText(completion.content?.trim() ?? ""),
        effects,
      };
    }

    messages.push({
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls,
    });
    const results = [];
    for (const call of completion.toolCalls) {
      const result = await runCall(tools, ctx, call, ++toolCalls, effects);
      messages.push({ role: "tool", toolCallId: call.id, content: result });
      results.push({ tool: call.name, result });
    }
    stepInput = JSON.stringify(results);
  }
}

/** A call past the limit is answered without running, so the model must reply. */
async function runCall(
  tools: readonly Tool[],
  ctx: ToolContext,
  call: ToolCall,
  ordinal: number,
  effects: ToolEffect[],
): Promise<string> {
  if (ordinal > MAX_TOOL_CALLS) {
    return JSON.stringify({ error: "tool limit reached: answer the customer" });
  }
  const outcome = await runTool(
    tools,
    ctx,
    call.name,
    parseArguments(call.arguments),
  );
  effects.push(...outcome.effects);
  return JSON.stringify(outcome.result);
}
