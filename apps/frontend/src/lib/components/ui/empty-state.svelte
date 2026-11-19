<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  title: string;
  description?: string;
  class?: string;
  action?: Snippet;
};

let { title, description, class: className = "", action }: Props = $props();
</script>

<div class="flex flex-col items-center px-6 py-10 text-center {className}">
	<p class="text-md font-medium text-fg">{title}</p>
	{#if description}
		<p class="mt-1 max-w-sm text-base text-pretty text-fg-muted">{description}</p>
	{/if}
	{#if action}
		<div class="mt-4">{@render action()}</div>
	{/if}
</div>
