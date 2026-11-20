/**
 * The `$app/*` modules a dashboard page imports. They exist only inside
 * SvelteKit. A page rendered by a test is on the server and never navigates.
 */
export const browser = false;

/** No layout ran, so a rendered page has no session user. */
export const page = { data: {} as Record<string, unknown> };

export async function goto(): Promise<void> {}

export async function invalidateAll(): Promise<void> {}
