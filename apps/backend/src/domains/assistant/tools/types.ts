import type { OrderDetail } from "@vendeya/types";

/** The conversation a tool runs for. Every read and write is scoped to it. */
export type ToolContext = {
  tenantId: string;
  channelAccountId: string;
  /** The customer's phone, as WhatsApp sends it. */
  phone: string;
  /** A simulated conversation reads real data and writes none. */
  simulated: boolean;
};

/**
 * What the turn does after the model's reply, outside the tool: a tool never
 * sends a message or alerts staff itself.
 */
export type ToolEffect =
  | {
      kind: "send_photos";
      productId: string;
      productName: string;
      storageKeys: string[];
    }
  | { kind: "hand_off"; reason: string }
  | { kind: "order_created"; order: OrderDetail };

/** What the model reads back, and the effects the turn carries out. */
export type ToolOutcome = { result: unknown; effects: ToolEffect[] };

/** The JSON Schema of a tool's arguments, as OpenAI's function tools take it. */
export type ToolParameters = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

export type Tool = {
  name: string;
  /** Read by the model to decide when to call the tool. */
  description: string;
  parameters: ToolParameters;
  run: (
    ctx: ToolContext,
    args: Record<string, unknown>,
  ) => Promise<ToolOutcome>;
};

/** Arguments the model got wrong. Its message goes back to the model. */
export class ToolArgumentError extends Error {}

export function answer(
  result: unknown,
  effects: ToolEffect[] = [],
): ToolOutcome {
  return { result, effects };
}
