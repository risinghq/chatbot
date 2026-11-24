import { OrderInputError } from "../../orders/index.ts";
import { InsufficientStockError } from "../../stock/index.ts";
import { catalogTools } from "./catalog.ts";
import { creditTools } from "./credit.ts";
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

export type ToolOptions = {
  /** The business has a Cálidda login, so it sells on Cálidda credit. */
  caliddaCredit: boolean;
  /** The business sells services or quotes per job, so staff closes each sale. */
  staffCloses: boolean;
};

/** The tools a business's assistant can call, in the order the model sees them. */
export function toolsFor(options: ToolOptions): readonly Tool[] {
  return [
    ...catalogTools,
    ...customerTools,
    ...orderTools.filter(
      (tool) => !(options.staffCloses && tool.name === "create_order"),
    ),
    ...(options.caliddaCredit ? creditTools : []),
  ];
}

/**
 * Runs one tool call from `tools`, the set the model was offered, so a tool
 * the business lacks is refused like an unknown one. A mistake the model can
 * correct (an unknown tool, wrong arguments, an order the stock or the order
 * rules refuse) comes back as `{ error }` for the model to read; any other
 * failure throws.
 */
export async function runTool(
  tools: readonly Tool[],
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === name);
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
