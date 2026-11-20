/** OpenAI models a business may run its assistant on. The first is the default. */
export const ASSISTANT_MODELS = ["gpt-5-mini", "gpt-5", "gpt-5-nano"] as const;
export type AssistantModel = (typeof ASSISTANT_MODELS)[number];

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
