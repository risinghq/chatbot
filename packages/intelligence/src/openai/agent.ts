import type OpenAI from "openai";
import type {
  AgentMessage,
  CompleteFn,
  Completion,
  CompletionRequest,
} from "../agent";
import { createTextClient } from "./client";

type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

function toOpenAI(message: AgentMessage): Params["messages"][number] {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    const calls = message.toolCalls ?? [];
    return {
      role: "assistant",
      content: message.content,
      ...(calls.length > 0 && {
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      }),
    };
  }
  return { role: message.role, content: message.content };
}

/**
 * Tools are not `strict`: their schemas have optional fields, which strict
 * mode refuses, and every tool checks its own arguments. Reasoning is low
 * because a customer on WhatsApp is waiting for the reply.
 */
export function createCompletion(apiKey: string): CompleteFn {
  const client = createTextClient(apiKey);
  return async (request: CompletionRequest): Promise<Completion> => {
    const completion = await client.chat.completions.create({
      model: request.model,
      reasoning_effort: "low",
      messages: request.messages.map(toOpenAI),
      tools: request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      tool_choice: request.allowTools ? "auto" : "none",
    });

    const message = completion.choices[0]?.message;
    const usage = completion.usage;
    return {
      content: message?.content ?? null,
      toolCalls: (message?.tool_calls ?? []).flatMap((call) =>
        call.type === "function"
          ? [
              {
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
              },
            ]
          : [],
      ),
      usage: usage
        ? {
            prompt: usage.prompt_tokens,
            completion: usage.completion_tokens,
            total: usage.total_tokens,
          }
        : null,
    };
  };
}
