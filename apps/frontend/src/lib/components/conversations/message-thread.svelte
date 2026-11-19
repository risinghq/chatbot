<script lang="ts">
import MessageBubble from "./message-bubble.svelte";
import type { ConversationMessage } from "@vendeya/types";

type Props = {
  messages: ConversationMessage[];
  currentUserSide?: "inbound" | "outbound";
};

let { messages, currentUserSide = "outbound" }: Props = $props();
</script>

<div class="flex flex-1 flex-col gap-2 overflow-y-auto p-4 md:p-6">
  {#if messages.length === 0}
    <p class="py-10 text-center text-sm text-fg-muted">Todavía no hay mensajes.</p>
  {/if}

  {#each messages as msg (msg.id)}
    <MessageBubble
      direction={msg.direction}
      type={msg.type}
      content={msg.content}
      status={msg.status}
      createdAt={msg.created_at}
      {currentUserSide}
    />
  {/each}
</div>
