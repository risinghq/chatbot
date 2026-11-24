/**
 * Whether a file fits an `accept` list as a file input reads it: comma-separated
 * extensions (".csv"), MIME types ("text/csv") and wildcards ("image/*"). A
 * dropped file skips the input's own filter, so a drop zone checks it here.
 */
export function acceptsFile(
  accept: string,
  file: { name: string; type: string },
): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) =>
      token.startsWith(".")
        ? name.endsWith(token)
        : token.endsWith("/*")
          ? type.startsWith(token.slice(0, -1))
          : type === token,
    );
}
