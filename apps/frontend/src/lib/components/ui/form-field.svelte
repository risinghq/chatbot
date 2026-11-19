<script lang="ts">
import type { Snippet } from "svelte";
import Label from "./label.svelte";

type Props = {
  label: string;
  for?: string;
  error?: string;
  class?: string;
  children: Snippet;
};

let {
  label,
  for: htmlFor,
  error,
  class: className = "",
  children,
}: Props = $props();
</script>

<div class="mb-4 {className}">
	<Label for={htmlFor}>{label}</Label>
	{@render children()}
	{#if error}
		<span role="alert" aria-live="polite" class="mt-1.5 block text-sm text-danger-text">{error}</span>
	{/if}
</div>
