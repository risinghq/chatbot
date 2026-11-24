/** The " / " that joins option values in a variant name, as "M / Rojo". */
const SEPARATOR = " / ";

function parts(name: string | null): string[] {
  return (name ?? "")
    .split(SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The option values that pick out a group of variants, such as "Rojo" among
 * "S / Rojo", "M / Rojo" and "S / Negro". A value every variant shares, or
 * only one variant has, picks out no group and is left out. Values come in
 * option order, sizes before colours, each option's in first-seen order.
 */
export function sharedParts(names: Array<string | null>): string[] {
  const seen = new Map<string, { count: number; option: number }>();
  for (const name of names) {
    parts(name).forEach((part, option) => {
      const found = seen.get(part);
      if (found) found.count += 1;
      else seen.set(part, { count: 1, option });
    });
  }
  return [...seen]
    .filter(([, { count }]) => count > 1 && count < names.length)
    .sort(([, a], [, b]) => a.option - b.option)
    .map(([part]) => part);
}

/** Whether the variant's name has `part` as one of its option values. */
export function hasPart(name: string | null, part: string): boolean {
  return parts(name).includes(part);
}
