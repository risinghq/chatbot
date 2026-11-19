<script lang="ts">
import type { Conversation } from "@vendeya/types";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import ConversationItem from "./conversation-item.svelte";

type Props = {
  conversations: Conversation[];
};

let { conversations }: Props = $props();

/**
 * A conversation is identified by (tenant, channel account, phone number): the
 * same contact writing to two of the business's numbers is two threads. The
 * link carries the channel account so the detail page opens the right one
 * instead of whichever was active most recently.
 */
function conversationKey(conv: Conversation): string {
  return `${conv.channel_account_id}:${conv.phone_number}`;
}
</script>

<div class="flex w-full shrink-0 flex-col border-r border-border-subtle bg-surface md:w-80">
	<div class="flex h-12 shrink-0 items-center border-b border-border-subtle px-4">
		<h1 class="text-md font-medium text-fg">Conversaciones</h1>
		<span class="ml-2 text-sm text-fg-muted tabular-nums">{conversations.length}</span>
	</div>

	<div class="flex-1 overflow-y-auto">
		{#each conversations as conv (conversationKey(conv))}
			<ConversationItem
				conversation={conv}
				href="/dashboard/conversations/{conv.phone_number}?channel={conv.channel_account_id}"
			/>
		{/each}

		{#if conversations.length === 0}
			<EmptyState
				title="Sin conversaciones activas"
				description="Cuando un cliente escriba a uno de tus números, aparecerá aquí."
			/>
		{/if}
	</div>
</div>
