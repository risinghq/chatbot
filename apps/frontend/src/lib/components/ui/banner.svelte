<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  tone?: "info" | "warning" | "danger" | "success";
  title?: string;
  class?: string;
  action?: Snippet;
  children?: Snippet;
};

let {
  tone = "info",
  title,
  class: className = "",
  action,
  children,
}: Props = $props();

const tones = {
  info: "bg-info-soft text-info-text",
  warning: "bg-warning-soft text-warning-text",
  danger: "bg-danger-soft text-danger-text",
  success: "bg-success-soft text-success-text",
};
</script>

<div
	role={tone === "danger" ? "alert" : "status"}
	class="flex flex-col gap-2 rounded-md px-3 py-2.5 text-base sm:flex-row sm:items-center sm:justify-between {tones[tone]} {className}"
>
	<div class="min-w-0">
		{#if title}<p class="font-medium">{title}</p>{/if}
		{#if children}<div class="text-fg">{@render children()}</div>{/if}
	</div>
	{#if action}<div class="shrink-0">{@render action()}</div>{/if}
</div>
