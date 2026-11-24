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
 * only one variant has, picks out no group and is left out.
 */
export function sharedParts(names: Array<string | null>): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    for (const part of new Set(parts(name))) {
      counts.set(part, (counts.get(part) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count > 1 && count < names.length)
    .map(([part]) => part);
}

/** Whether the variant's name has `part` as one of its option values. */
export function hasPart(name: string | null, part: string): boolean {
  return parts(name).includes(part);
}
