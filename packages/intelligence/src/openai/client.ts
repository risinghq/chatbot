import OpenAI from "openai";

/**
 * One client per tenant API key. Callers hold the client they resolved for
 * the turn; a missing key throws here, which the caller's AI-unavailable
 * path already covers.
 */
export function createTextClient(apiKey: string | undefined): OpenAI {
  return new OpenAI({ apiKey });
}
