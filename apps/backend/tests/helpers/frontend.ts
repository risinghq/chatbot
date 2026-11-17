/**
 * A dashboard file by its path under `apps/frontend/src`. The import is
 * computed so that tsc does not follow it: the dashboard has its own tsconfig
 * and generated `$types`.
 */
export function frontendPath(file: string): string {
  return new URL(`../../../frontend/src/${file}`, import.meta.url).pathname;
}

export async function importFrontend<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ frontendPath(file))) as T;
}
