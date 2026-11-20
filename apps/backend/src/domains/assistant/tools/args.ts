import { ToolArgumentError } from "./types.ts";

export function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolArgumentError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

/** Null when the model left the argument out, sent null or sent "". */
export function optionalText(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ToolArgumentError(`${key} must be a string`);
  }
  return value.trim() || null;
}

export type LineArg = { variantId: string; quantity: number };

/** `lines` as variant ids and whole quantities above 0, each variant once. */
export function lines(args: Record<string, unknown>): LineArg[] {
  const value = args.lines;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolArgumentError("lines must list at least one product variant");
  }
  const parsed = value.map((line) => {
    const row = (line ?? {}) as Record<string, unknown>;
    const quantity = row.quantity;
    if (!Number.isSafeInteger(quantity) || (quantity as number) < 1) {
      throw new ToolArgumentError(
        "each quantity must be a whole number above 0",
      );
    }
    return { variantId: text(row, "variant_id"), quantity: quantity as number };
  });
  const ids = new Set(parsed.map((l) => l.variantId));
  if (ids.size !== parsed.length) {
    throw new ToolArgumentError(
      "list each variant once, with its total quantity",
    );
  }
  return parsed;
}

/** Soles for the model, which reads "S/ 59.90" better than 5990 cents. */
export function soles(cents: number): string {
  return `S/ ${(cents / 100).toFixed(2)}`;
}
