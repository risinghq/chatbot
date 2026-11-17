/**
 * The `$app/*` modules a dashboard page imports. They exist only inside
 * SvelteKit. A page rendered by a test is on the server and never navigates.
 */
export const browser = false;

export async function goto(): Promise<void> {}

export async function invalidateAll(): Promise<void> {}
