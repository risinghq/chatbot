/**
 * Variables and secrets every test file runs with. They override .dev.vars, so
 * a developer's real credentials never reach a test. The provider hosts do not
 * resolve, so a test that forgets to fake `fetch` fails instead of calling out.
 */
export const TEST_BINDINGS = {
  ENVIRONMENT: "test",
  PUBLIC_URL: "https://vendeya.test",
  LOG_LEVEL: "silent",
  GRAPH_API_BASE_URL: "https://graph.test",
  BOT_RESPONSE_DELAY_MS: "0",
  SECRETS_KEY: "0".repeat(64),
  CALIDDA_BASE_URL: "https://calidda.test",
} as const;
