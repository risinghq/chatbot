import { setupEventSubscribers } from "./event-bus-setup.ts";
import { CheckEligibilityHandler } from "../domains/eligibility/handlers/check-eligibility-handler.ts";
import { FNBProvider } from "../domains/eligibility/providers/fnb-provider.ts";
import { PowerBIProvider } from "../domains/eligibility/providers/powerbi-provider.ts";

export const eligibilityHandler = new CheckEligibilityHandler(
  new FNBProvider(),
  new PowerBIProvider(),
);

let initialized = false;

/** Wires the event subscribers once per isolate. */
export function initializeApplication(): void {
  if (initialized) return;
  initialized = true;

  setupEventSubscribers();
}
