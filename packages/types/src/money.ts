const AMOUNT = /^\d+(?:[.,]\d{1,2})?$/;

/**
 * Cents from what a person typed ("49.90", "49,9", "50"), or null when it is
 * not an amount of 0 or more with at most two decimals. The API keeps money
 * in cents so sums are exact.
 */
export function parseCents(text: string): number | null {
  const trimmed = text.trim();
  if (!AMOUNT.test(trimmed)) return null;
  return Math.round(Number(trimmed.replace(",", ".")) * 100);
}
