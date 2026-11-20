/**
 * Whether D1 refused a write because it broke a constraint of this kind. D1
 * raises a plain Error whose message carries SQLite's text, such as
 * "D1_ERROR: CHECK constraint failed: on_hand >= 0", so the message is the only
 * signal.
 */
export function isConstraintError(
  error: unknown,
  kind: "CHECK" | "UNIQUE" | "FOREIGN KEY",
): boolean {
  return (
    error instanceof Error &&
    error.message.includes(`${kind} constraint failed`)
  );
}
