import OpenAI from "openai";

let apiKey: string | undefined;
let textClient: OpenAI | null = null;

/**
 * The host passes the key once at startup, because a Worker reads secrets
 * from its bindings, not from `process.env`.
 */
export function configureOpenAI(key: string | undefined): void {
  apiKey = key || undefined;
  textClient = null;
}

export function getTextClient(): OpenAI {
  if (!textClient) {
    textClient = new OpenAI({ apiKey });
  }
  return textClient;
}
