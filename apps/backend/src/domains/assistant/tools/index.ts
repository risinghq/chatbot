import { OrderInputError } from "../../orders/index.ts";
import { InsufficientStockError } from "../../stock/index.ts";
import { catalogTools } from "./catalog.ts";
import { customerTools } from "./customer.ts";
import { orderTools } from "./orders.ts";
import {
  ToolArgumentError,
  answer,
  type Tool,
  type ToolContext,
  type ToolOutcome,
} from "./types.ts";

export type { Tool, ToolContext, ToolEffect, ToolOutcome } from "./types.ts";

/** Every tool the assistant can call, in the order the model sees them. */
export const TOOLS: readonly Tool[] = [
  ...catalogTools,
  ...customerTools,
  ...orderTools,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Runs one tool call. A mistake the model can correct (an unknown tool,
 * wrong arguments, an order the stock or the order rules refuse) comes back
 * as `{ error }` for the model to read; any other failure throws.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<ToolOutcome> {
  const tool = BY_NAME.get(name);
  if (!tool) return answer({ error: `there is no tool named ${name}` });
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return answer({ error: "arguments must be a JSON object" });
  }
  try {
    return await tool.run(ctx, args as Record<string, unknown>);
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return answer({ error: "not enough stock for this order" });
    }
    if (
      error instanceof ToolArgumentError ||
      error instanceof OrderInputError
    ) {
      return answer({ error: error.message });
    }
    throw error;
  }
}
