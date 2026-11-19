<script lang="ts">
import { fly } from "svelte/transition";
import { cubicOut } from "svelte/easing";

type Props = {
  id: string;
  message: string;
  type: "success" | "error" | "info";
  onDismiss: (id: string) => void;
};

let { id, message, type, onDismiss }: Props = $props();

const colors = {
  success: "text-success",
  error: "text-danger",
  info: "text-fg-muted",
};
</script>

<div
	transition:fly={{ y: 12, duration: 150, easing: cubicOut }}
	role={type === "error" ? "alert" : "status"}
	class="flex max-w-md min-w-72 items-center justify-between gap-3 rounded-lg border border-popover-border bg-surface py-2 pr-2 pl-3 shadow-md"
>
	<div class="flex items-center gap-2">
		<span class="shrink-0 {colors[type]}">
			<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
				{#if type === "success"}
					<polyline points="20 6 9 17 4 12"></polyline>
				{:else if type === "error"}
					<line x1="18" y1="6" x2="6" y2="18"></line>
					<line x1="6" y1="6" x2="18" y2="18"></line>
				{:else}
					<circle cx="12" cy="12" r="10"></circle>
					<line x1="12" y1="16" x2="12" y2="12"></line>
					<line x1="12" y1="8" x2="12.01" y2="8"></line>
				{/if}
			</svg>
		</span>
		<span class="text-base text-fg">{message}</span>
	</div>
	<button
		onclick={() => onDismiss(id)}
		class="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:size-11"
		aria-label="Cerrar"
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
			<line x1="18" y1="6" x2="6" y2="18"/>
			<line x1="6" y1="6" x2="18" y2="18"/>
		</svg>
	</button>
</div>
