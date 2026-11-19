<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  title: string;
  subtitle?: string;
  actions?: Snippet;
};

let { title, subtitle, actions }: Props = $props();
</script>

<header class="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
	<div class="min-w-0">
		<h1 class="text-xl text-fg">{title}</h1>
		{#if subtitle}
			<p class="mt-1 text-base text-fg-muted">{subtitle}</p>
		{/if}
	</div>
	{#if actions}
		<div class="flex flex-wrap gap-2">{@render actions()}</div>
	{/if}
</header>
