import { OPENAI_API_KEY_SETTING } from "../../src/domains/settings/openai.ts";
import { TenantSecrets } from "../../src/domains/settings/tenant-secrets.ts";

const OPENAI_ORIGIN = "https://api.openai.com";

/** What the model answers when the test scripted nothing more. */
export const DEFAULT_REPLY = "Hola, ¿en qué te puedo ayudar?";

type Answer =
  | { content: string }
  | { toolCalls: { name: string; arguments: Record<string, unknown> }[] }
  | { status: number };

/** One request the turn sent to the model, as OpenAI received it. */
export type ModelRequest = {
  model: string;
  messages: { role: string; content: string | null; tool_call_id?: string }[];
  tool_choice: string;
  tools: { function: { name: string } }[];
};

function completion(answer: Answer): Record<string, unknown> {
  const toolCalls =
    "toolCalls" in answer
      ? answer.toolCalls.map((call) => ({
          id: `call_${crypto.randomUUID()}`,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }))
      : undefined;
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "content" in answer ? answer.content : null,
          refusal: null,
          ...(toolCalls && { tool_calls: toolCalls }),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

/**
 * Stands in for OpenAI's chat completions. It wraps the `fetch` installed when
 * it is called, answers requests to api.openai.com from the script, and
 * passes every other request through, so it sits on top of a test's Graph
 * fake. Restore it before the fake beneath it.
 */
export function fakeModel() {
  const requests: ModelRequest[] = [];
  const script: Answer[] = [];
  const inner = globalThis.fetch;
  let hook: (call: number) => Promise<void> | void = () => {};

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== OPENAI_ORIGIN) {
      return inner(input, init);
    }
    requests.push((await request.json()) as ModelRequest);
    await hook(requests.length);
    const answer = script.shift() ?? { content: DEFAULT_REPLY };
    if ("status" in answer) {
      return Response.json(
        { error: { message: "fake model failure", type: "server_error" } },
        { status: answer.status },
      );
    }
    return Response.json(completion(answer));
  }) as typeof fetch;

  return {
    requests,
    /** The next model call answers the customer with `content`. */
    says(content: string) {
      script.push({ content });
    },
    /** The next model call asks for these tools. */
    calls(
      ...toolCalls: { name: string; arguments: Record<string, unknown> }[]
    ) {
      script.push({ toolCalls });
    },
    /** The next model call fails with `status`. 400 is not retried. */
    fails(status = 400) {
      script.push({ status });
    },
    /**
     * Runs `next` on each call, numbered from 1, before the call is answered.
     * An answer it scripts, with nothing scripted before it, answers that call.
     */
    onCall(next: (call: number) => Promise<void> | void) {
      hook = next;
    },
    restore() {
      globalThis.fetch = inner;
    },
  };
}

export type FakeModel = ReturnType<typeof fakeModel>;

/** Stores an OpenAI key for the tenant, so its turns call the model. */
export async function withOpenAiKey(tenantId: string): Promise<void> {
  await TenantSecrets.set(tenantId, OPENAI_API_KEY_SETTING, "sk-test-key");
}
