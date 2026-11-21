import { CheckEligibilityHandler } from "./handlers/check-eligibility-handler.ts";
import { FNBProvider } from "./providers/fnb-provider.ts";
import { PowerBIProvider } from "./providers/powerbi-provider.ts";

/** The Cálidda credit check, asking FNB and Power BI together. */
export const eligibilityHandler = new CheckEligibilityHandler(
  new FNBProvider(),
  new PowerBIProvider(),
);
