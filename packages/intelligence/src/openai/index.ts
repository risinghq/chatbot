import type OpenAI from "openai";
import type { IntelligenceProvider } from "../provider";
import { createTextClient } from "./client";
import * as Classification from "./classification";
import * as Answer from "./models/answer";
import * as Recover from "./models/recover";

/**
 * A provider bound to one tenant's OpenAI key. The client is created on first
 * use, so a message the regexes answer never builds one, and a tenant with no
 * key fails at the call, the same place an outage fails.
 */
export function createProvider(
  apiKey: string | null | undefined,
): IntelligenceProvider {
  let client: OpenAI | null = null;
  const textClient = () => (client ??= createTextClient(apiKey ?? undefined));

  return {
    isQuestion: (message) => Classification.isQuestion(textClient(), message),

    shouldEscalate: (message) =>
      Classification.shouldEscalate(textClient(), message),

    answerQuestion: (message, context) =>
      Answer.answerQuestion(textClient(), message, context),

    recoverUnclearResponse: (message, context) =>
      Recover.recoverUnclearResponse(textClient(), message, context),
  };
}
