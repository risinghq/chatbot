// Renders one Svelte component to an HTML string, for the backend's tests.
// `svelte` resolves only from this workspace, so a test there goes through
// this file instead of importing `svelte/server` itself. The caller's bundler
// compiles the `.svelte` file.
import { render } from "svelte/server";

export async function renderComponent(
  path: string,
  props: Record<string, unknown>,
): Promise<string> {
  const { default: Component } = await import(/* @vite-ignore */ path);
  return render(Component, { props }).body;
}
