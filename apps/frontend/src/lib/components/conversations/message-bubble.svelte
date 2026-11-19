<script lang="ts">
import { formatTime } from "#lib/utils/formatters.js";
import type { Snippet } from "svelte";
import type { StoredMessageType } from "@vendeya/types";

type Props = {
  direction: "inbound" | "outbound";
  type: StoredMessageType;
  content: string;
  status?: string;
  createdAt: number;
  actions?: Snippet;
  currentUserSide?: "inbound" | "outbound";
};

let {
  direction,
  type,
  content,
  status,
  createdAt,
  actions,
  currentUserSide = "outbound",
}: Props = $props();

const isMe = $derived(direction === currentUserSide);

// `received` and `sent` are the normal case and show nothing.
const exceptionLabels: Record<string, string> = {
  queued: "En cola",
  failed: "No enviado",
  cancelled: "Cancelado",
};
const exception = $derived(status ? exceptionLabels[status] : undefined);
</script>

<div class="group flex {isMe ? 'justify-end' : 'justify-start'}">
  <div
    class="relative max-w-[min(36rem,85%)] rounded-lg px-3 py-2 {isMe
      ? 'bg-accent-soft text-fg'
      : 'border border-border-subtle bg-surface text-fg'}"
  >
    {#if actions}
      <div
        class="absolute -top-3 -right-3 z-10 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
      >
        {@render actions()}
      </div>
    {/if}
    {#if type === "image"}
      <img src="/media/{content}" alt="Imagen" class="mb-1 h-auto max-w-full rounded-md" />
    {:else}
      <p class="text-base whitespace-pre-wrap break-words">{content}</p>
    {/if}
    <span class="mt-1 block text-right text-xs text-fg-muted tabular-nums">
      {formatTime(createdAt)}{#if exception}&nbsp;· <span class={status === "failed" ? "text-danger-text" : ""}>{exception}</span>{/if}
    </span>
  </div>
</div>
