import type { CreditCheck } from "@vendeya/types";

/**
 * The body of `GET /api/providers/:dni`. `result` is the credit check, or
 * `{ error }` when the check could not run.
 */
export type ProviderLookup = {
  dni: string;
  result: LookupResult;
  /** The providers whose circuit breaker was closed when the check ran. */
  providersChecked: string[];
};

export type LookupResult = CreditCheck | { error: string };
