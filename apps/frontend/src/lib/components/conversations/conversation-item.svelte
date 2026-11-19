<script lang="ts">
import type { Conversation } from "@vendeya/types";
import { phaseLabel } from "#lib/utils/conversation-phase.js";
import { formatPhone } from "#lib/utils/formatters.js";

type Props = {
  conversation: Conversation;
  /** Only the simulator has an open thread to mark. The inbox has none. */
  isSelected?: boolean;
  onclick?: () => void;
  href?: string;
};

let { conversation, isSelected = false, onclick, href }: Props = $props();

const rowClass = $derived(
  `block w-full border-b border-border-subtle px-4 py-3 text-left transition-colors duration-150 ${
    isSelected ? "bg-sunken-strong" : "hover:bg-hover"
  }`,
);
</script>

{#snippet body()}
	<div class="flex items-center justify-between gap-2">
		<span class="truncate text-base text-fg {isSelected ? 'font-medium' : ''}">
			{conversation.client_name || formatPhone(conversation.phone_number)}
		</span>
		{#if conversation.status === "human_takeover"}
			<span class="size-2 shrink-0 rounded-full bg-danger" title="Espera a una persona"></span>
		{/if}
	</div>
	{#if conversation.client_name}
		<p class="truncate font-mono text-sm text-fg-muted">{formatPhone(conversation.phone_number)}</p>
	{/if}
	<div class="mt-1 flex items-center gap-1.5">
		<span class="truncate text-sm text-fg-muted">{phaseLabel(conversation.current_state)}</span>
		{#if conversation.persona_id}
			<span class="inline-flex h-4 items-center rounded-sm bg-warning-soft px-1 text-xs text-warning-text">Prueba</span>
		{/if}
	</div>
	{#if conversation.handover_reason}
		<p class="mt-1 truncate text-sm text-danger-text">{conversation.handover_reason}</p>
	{/if}
{/snippet}

{#if href}
	<a {href} class={rowClass} aria-current={isSelected ? "page" : undefined}>{@render body()}</a>
{:else}
	<button type="button" {onclick} class={rowClass} aria-pressed={isSelected}>{@render body()}</button>
{/if}
