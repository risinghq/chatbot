/** A conversation as the assistant model reads it, provider-neutral. */
export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolCall = {
  id: string;
  name: string;
  /** The arguments as the model wrote them: JSON, possibly malformed. */
  arguments: string;
};

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type CompletionRequest = {
  model: string;
  messages: AgentMessage[];
  tools: readonly ToolSpec[];
  /** False makes the model answer in text without calling a tool. */
  allowTools: boolean;
};

export type Completion = {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { prompt: number; completion: number; total: number } | null;
};

/** One model call. Throws what the provider throws: no key, refused key, outage. */
export type CompleteFn = (request: CompletionRequest) => Promise<Completion>;
