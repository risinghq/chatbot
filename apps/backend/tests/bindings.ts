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
  WHATSAPP_APP_SECRET: "test-meta-app-secret",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
  OPENAI_API_KEY: "",
  CALIDDA_BASE_URL: "https://calidda.test",
  CALIDDA_USERNAME: "test-user",
  CALIDDA_PASSWORD: "test-password",
  POWERBI_RESOURCE_KEY: "test-resource-key",
  POWERBI_REPORT_ID: "test-report",
  POWERBI_DATASET_ID: "test-dataset",
  POWERBI_MODEL_ID: "1",
} as const;
