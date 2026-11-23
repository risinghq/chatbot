<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  title: string;
  description?: string;
  action?: Snippet;
  children: Snippet;
};

let { title, description, action, children }: Props = $props();
</script>

<section class="overflow-hidden rounded-md border border-border bg-surface">
	<header class="flex flex-col gap-3 border-b border-border-subtle px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
		<div class="min-w-0">
			<h3 class="text-md text-fg">{title}</h3>
			{#if description}
				<p class="mt-1 max-w-prose text-sm text-pretty text-fg-muted">{description}</p>
			{/if}
		</div>
		{#if action}
			<div class="shrink-0">{@render action()}</div>
		{/if}
	</header>
	{@render children()}
</section>
