<script lang="ts">
import { onMount } from "svelte";
import type { Conversation } from "@vendeya/types";
import { fetchApi } from "#lib/utils/api.js";
import ConversationList from "#lib/components/conversations/conversation-list.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let localConversations = $state<Conversation[] | null>(null);
let polling: ReturnType<typeof setInterval> | null = null;

let conversations = $derived(localConversations ?? data.conversations);

async function loadConversations() {
  try {
    localConversations = await fetchApi<Conversation[]>("/api/conversations");
  } catch (error) {
    console.error("Failed to load conversations:", error);
  }
}

onMount(() => {
  polling = setInterval(() => {
    loadConversations();
  }, 2000);

  return () => {
    if (polling) clearInterval(polling);
  };
});
</script>

<PageTitle title="Conversaciones" />

<!-- 3rem is the mobile top bar in the dashboard layout. -->
<div class="flex h-[calc(100dvh-3rem)] overflow-hidden md:h-dvh">
	<ConversationList {conversations} />

	<div class="hidden min-w-0 flex-1 items-center justify-center md:flex">
		<p class="text-base text-fg-muted">Elige una conversación de la lista.</p>
	</div>
</div>
