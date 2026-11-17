import { env } from "cloudflare:workers";
import { configureOpenAI } from "@vendeya/intelligence";
import { setupEventSubscribers } from "./event-bus-setup.ts";
import { CheckEligibilityHandler } from "../domains/eligibility/handlers/check-eligibility-handler.ts";
import { FNBProvider } from "../domains/eligibility/providers/fnb-provider.ts";
import { PowerBIProvider } from "../domains/eligibility/providers/powerbi-provider.ts";
import { initializeEnrichmentRegistry } from "../conversation/enrichment/index.ts";
import { RetryEligibilityHandler } from "../domains/recovery/handlers/retry-eligibility-handler.ts";

const fnbProvider = new FNBProvider();
const powerbiProvider = new PowerBIProvider();

export const eligibilityHandler = new CheckEligibilityHandler(
  fnbProvider,
  powerbiProvider,
);

export const retryEligibilityHandler = new RetryEligibilityHandler(
  eligibilityHandler,
);

let initialized = false;

/** Wires the event subscribers and enrichment handlers once per isolate. */
export function initializeApplication(): void {
  if (initialized) return;
  initialized = true;

  configureOpenAI(env.OPENAI_API_KEY);

  setupEventSubscribers();
  initializeEnrichmentRegistry(eligibilityHandler);
}
