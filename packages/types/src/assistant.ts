/** OpenAI models a business may run its assistant on. The first is the default. */
export const ASSISTANT_MODELS = ["gpt-5-mini", "gpt-5", "gpt-5-nano"] as const;
export type AssistantModel = (typeof ASSISTANT_MODELS)[number];

/**
 * OpenAI's list price in USD per million tokens, without the cached-input
 * discount, so a cost estimate errs high. Update it when OpenAI changes a price.
 */
export const MODEL_PRICES: Record<
  AssistantModel,
  { inputUsdPerMillion: number; outputUsdPerMillion: number }
> = {
  "gpt-5-mini": { inputUsdPerMillion: 0.25, outputUsdPerMillion: 2 },
  "gpt-5": { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
  "gpt-5-nano": { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.4 },
};

/**
 * Longest text a business may store in one field. Every field goes into each
 * model call, so a long field costs on every customer message.
 */
export const ASSISTANT_TEXT_LIMIT = 8000;

export type AssistantSettings = {
  instructions: string;
  faq: string;
  policies: string;
  model: AssistantModel;
  stock_location_id: string | null;
  updated_at: number | null;
};
