import { formatPrice } from "./formatters.js";

export { parseCents } from "@vendeya/types";

/** People read units; the API sends cents. */
export function formatCents(cents: number | null): string {
  return cents === null ? "–" : formatPrice(cents / 100);
}
