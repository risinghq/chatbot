<script lang="ts">
import { onMount } from "svelte";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import { formatPhone } from "#lib/utils/formatters.js";
import Button from "#lib/components/ui/button.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import MessageBubble from "#lib/components/conversations/message-bubble.svelte";
import MessageInput from "#lib/components/conversations/message-input.svelte";
import ConversationItem from "#lib/components/conversations/conversation-item.svelte";
import AssistantTabs from "#lib/components/assistant/assistant-tabs.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import type { Conversation, ReplayData, ReplayMetadata } from "@vendeya/types";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let testConversations = $state<Conversation[]>([]);
let selectedPhone = $state<string | null>(null);
let messages = $state<any[]>([]);
let currentInput = $state("");
let conversation = $state<any>(null);
let loading = $state(false);
let messagesContainer = $state<HTMLDivElement>();
let polling: ReturnType<typeof setInterval> | null = null;
// Null until the status loads; the composer stays usable meanwhile.
let hasOpenAiKey = $state<boolean | null>(null);

let replayMode = $state(false);
let replayMetadata = $state<ReplayMetadata | null>(null);
let editingMessageIndex = $state<number | null>(null);
let editedContent = $state("");

async function loadTestConversations() {
  testConversations = await fetchApi<Conversation[]>(
    "/api/simulator/conversations",
  );
}

async function loadConversation(phone: string) {
  const data = await fetchApi<any>(`/api/simulator/conversation/${phone}`);
  conversation = data.conversation;
  messages = data.messages;
  setTimeout(scrollToBottom, 100);
}

function scrollToBottom() {
  if (messagesContainer) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

async function createNewConversation() {
  loading = true;
  try {
    const created = await fetchApi<Conversation>(
      "/api/simulator/conversations",
      {
        method: "POST",
      },
    );

    await loadTestConversations();
    selectedPhone = created.phone_number;
  } catch (error) {
    console.error("Failed to create conversation:", error);
    toast.error("No se pudo crear la simulación.");
  } finally {
    loading = false;
  }
}

async function deleteConversation(phone: string) {
  if (!confirm("¿Eliminar esta simulación?")) return;

  loading = true;
  try {
    await fetchApi(`/api/simulator/conversations/${phone}`, {
      method: "DELETE",
    });

    if (selectedPhone === phone) {
      selectedPhone = null;
      messages = [];
      conversation = null;
    }

    await loadTestConversations();
  } catch (error) {
    console.error("Failed to delete conversation:", error);
    toast.error("No se pudo eliminar la simulación.");
  } finally {
    loading = false;
  }
}

async function sendMessage(messageText?: string) {
  if (!selectedPhone) return;

  const textToSend = messageText || currentInput.trim();
  if (!textToSend) return;

  loading = true;
  if (!messageText) currentInput = "";

  messages = [
    ...messages,
    {
      id: Date.now().toString(),
      direction: "inbound",
      type: "text",
      content: textToSend,
      created_at: new Date().toISOString(),
    },
  ];

  setTimeout(scrollToBottom, 50);

  try {
    await fetchApi("/api/simulator/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumber: selectedPhone,
        message: textToSend,
      }),
    });

    if (selectedPhone) {
      const phone = selectedPhone;
      setTimeout(() => loadConversation(phone), 1000);
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // Nothing was stored: give the text back and show the notice.
      hasOpenAiKey = false;
      messages = messages.slice(0, -1);
      if (!messageText) currentInput = textToSend;
    } else {
      console.error("Send error:", error);
      toast.error("El asistente no pudo responder. Intenta de nuevo.");
    }
  } finally {
    loading = false;
  }
}

async function resetConversation() {
  if (!selectedPhone) return;
  if (!confirm("¿Reiniciar la conversación?")) return;

  await fetchApi(`/api/simulator/reset/${selectedPhone}`, {
    method: "POST",
  });

  messages = [];
  conversation = null;
  replayMode = false;
  replayMetadata = null;
  await loadConversation(selectedPhone);
}

async function loadReplayConversation(
  sourcePhone: string,
  sourceChannel: string | null,
) {
  try {
    // Both calls need the number the conversation happened on: the API
    // refuses to guess when the contact has written to more than one of them.
    const channelQuery = sourceChannel
      ? `?channel=${encodeURIComponent(sourceChannel)}`
      : "";

    const replayData = await fetchApi<ReplayData>(
      `/api/conversations/${sourcePhone}/replay${channelQuery}`,
    );

    replayMode = true;
    replayMetadata = replayData.metadata;

    const loaded = await fetchApi<{ simulatorPhone: string }>(
      "/api/simulator/load",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePhone, sourceChannel }),
      },
    );

    // The reserved simulator contact the replay was loaded onto.
    selectedPhone = loaded.simulatorPhone;
    await loadTestConversations();
    await loadConversation(selectedPhone);
  } catch (error) {
    console.error("Failed to load replay:", error);
    toast.error("No se pudo cargar la conversación.");
  }
}

function startEditing(index: number) {
  const msg = messages[index];
  if (msg.direction !== "inbound") return;

  editingMessageIndex = index;
  editedContent = msg.content;
}

function cancelEditing() {
  editingMessageIndex = null;
  editedContent = "";
}

async function applyEdit(index: number) {
  if (!selectedPhone) return;

  const originalMsg = messages[index];
  const newContent = editedContent.trim();

  if (!newContent) {
    cancelEditing();
    return;
  }

  if (newContent === originalMsg.content) {
    cancelEditing();
    return;
  }

  const futureMessagesCount = messages.length - index - 1;

  if (futureMessagesCount > 0) {
    const confirmed = confirm(
      `Editar este mensaje descartará los ${futureMessagesCount} mensajes siguientes. ¿Continuar?`,
    );
    if (!confirmed) {
      cancelEditing();
      return;
    }
  }

  loading = true;
  cancelEditing();

  try {
    await fetchApi(`/api/simulator/reset/${selectedPhone}`, {
      method: "POST",
    });

    for (let i = 0; i <= index; i++) {
      const msg = messages[i];
      if (msg.direction === "inbound") {
        const content = i === index ? newContent : msg.content;

        await fetchApi("/api/simulator/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phoneNumber: selectedPhone,
            message: content,
          }),
        });

        // Give the simulator time to process each message.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    await loadConversation(selectedPhone);
  } catch (error) {
    console.error("Failed to apply edit:", error);
    toast.error("No se pudo aplicar la edición.");
  } finally {
    loading = false;
  }
}

function exitReplayMode() {
  replayMode = false;
  replayMetadata = null;
  resetConversation();
}

$effect(() => {
  if (selectedPhone) {
    loadConversation(selectedPhone);
  }
});

onMount(() => {
  fetchApi<{ hasOpenAiKey: boolean }>("/api/simulator/status")
    .then((status) => (hasOpenAiKey = status.hasOpenAiKey))
    .catch(() => {});

  if (data.loadPhone) {
    loadReplayConversation(data.loadPhone, data.loadChannel);
  } else {
    loadTestConversations().then(() => {
      if (testConversations.length > 0 && !selectedPhone) {
        selectedPhone = testConversations[0]?.phone_number ?? null;
      }
    });
  }

  polling = setInterval(() => {
    loadTestConversations();
    if (selectedPhone) loadConversation(selectedPhone);
  }, 2000);

  return () => {
    if (polling) clearInterval(polling);
  };
});
</script>

<PageTitle title="Probar el asistente" />

<!-- 3rem is the mobile top bar in the dashboard layout, and 3rem more this page's tab bar. -->
<div class="flex h-12 shrink-0 items-end gap-4 border-b border-border-subtle bg-surface px-4">
	<h1 class="flex h-9 items-center text-md font-medium text-fg">Asistente</h1>
	<AssistantTabs />
</div>
<div class="flex h-[calc(100dvh-6rem)] overflow-hidden md:h-[calc(100dvh-3rem)]">
	<div
		class="w-full shrink-0 flex-col border-r border-border-subtle bg-surface md:flex md:w-80 {selectedPhone
			? 'hidden'
			: 'flex'}"
	>
		<div class="flex h-12 shrink-0 items-center gap-1 border-b border-border-subtle pr-2 pl-4">
			<h2 class="flex-1 text-md font-medium text-fg">Simulaciones</h2>
			<Button variant="ghost" size="sm" onclick={createNewConversation} disabled={loading} aria-label="Nueva simulación">
				<Icon name="plus" />
			</Button>
		</div>

		<div class="flex-1 overflow-y-auto">
			{#each testConversations as conv (conv.phone_number)}
				<ConversationItem
					conversation={conv}
					isSelected={selectedPhone === conv.phone_number}
					onclick={() => (selectedPhone = conv.phone_number)}
				/>
			{/each}

			{#if testConversations.length === 0}
				<EmptyState
					title="Sin simulaciones"
					description="Crea una para probar al bot sin escribir desde WhatsApp."
				>
					{#snippet action()}
						<Button size="sm" onclick={createNewConversation} disabled={loading}>Nueva simulación</Button>
					{/snippet}
				</EmptyState>
			{/if}
		</div>
	</div>

	<div class="min-w-0 flex-1 flex-col bg-canvas md:flex {selectedPhone ? 'flex' : 'hidden'}">
		{#if selectedPhone && conversation}
			<header class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle bg-surface px-4 py-2 md:min-h-12">
				<Button
					variant="ghost"
					size="sm"
					class="-ml-1 md:hidden"
					onclick={() => (selectedPhone = null)}
					aria-label="Volver a simulaciones"
				>
					<Icon name="arrow" class="size-4 rotate-180" />
				</Button>
				<div class="min-w-0 flex-1">
					<h2 class="truncate text-md font-medium text-fg">
						{conversation.customer_name || formatPhone(selectedPhone)}
					</h2>
					{#if conversation.customer_name}
						<p class="font-mono text-sm text-fg-muted">{formatPhone(selectedPhone)}</p>
					{/if}
				</div>
				{#if conversation.status === "human_takeover"}
					<Badge variant="error">
						<span title={conversation.handover_reason || undefined}>Intervención activa</span>
					</Badge>
				{/if}
				{#if replayMode}
					<Button variant="secondary" size="sm" onclick={exitReplayMode}>Salir de depuración</Button>
				{:else}
					<Button variant="secondary" size="sm" onclick={resetConversation}>Reiniciar</Button>
					<Button variant="secondary" size="sm" onclick={() => deleteConversation(selectedPhone!)}>Eliminar</Button>
				{/if}
			</header>

			{#if hasOpenAiKey === false}
				<div class="shrink-0 border-b border-border-subtle p-3">
					<Banner tone="warning" title="Falta la clave de OpenAI">
						El asistente la usa para responder. {data.user.role === "admin"
							? "Agrégala en Ajustes y vuelve a probar."
							: "Pide a un administrador que la agregue en Ajustes."}
						{#snippet action()}
							{#if data.user.role === "admin"}
								<Button size="sm" variant="secondary" href="/dashboard/admin/settings">Agregar clave</Button>
							{/if}
						{/snippet}
					</Banner>
				</div>
			{/if}

			{#if replayMode && replayMetadata}
				<div class="shrink-0 border-b border-border-subtle p-3">
					<Banner tone="warning" title="Modo depuración">
						Copia de <span class="font-mono">{replayMetadata.customerName || formatPhone(replayMetadata.conversationId)}</span>.
						Edita un mensaje del cliente para volver a ejecutar desde ahí.
					</Banner>
				</div>
			{/if}

			<div bind:this={messagesContainer} class="flex flex-1 flex-col gap-2 overflow-y-auto p-4 md:p-6">
				{#if messages.length === 0}
					<p class="py-10 text-center text-sm text-fg-muted">Escribe un mensaje para empezar la simulación.</p>
				{/if}

				{#each messages as msg, i (msg.id)}
					{#if editingMessageIndex === i}
						<div class="ml-auto w-full max-w-xl rounded-lg border border-border bg-surface p-3 shadow-sm">
							<label for="edit-message" class="mb-1.5 block text-sm text-fg-muted">Editar mensaje</label>
							<Textarea id="edit-message" bind:value={editedContent} rows={3} />
							<div class="mt-3 flex justify-end gap-2">
								<Button variant="secondary" size="sm" onclick={cancelEditing} disabled={loading}>Cancelar</Button>
								<Button size="sm" onclick={() => applyEdit(i)} disabled={loading}>
									{loading ? "Aplicando…" : "Guardar y volver a ejecutar"}
								</Button>
							</div>
						</div>
					{:else}
						<MessageBubble
							direction={msg.direction}
							type={msg.type}
							content={msg.content}
							createdAt={msg.created_at}
							currentUserSide="inbound"
						>
							{#snippet actions()}
								{#if replayMode && msg.direction === "inbound"}
									<button
										type="button"
										onclick={() => startEditing(i)}
										disabled={loading}
										aria-label="Editar mensaje"
										class="inline-flex size-7 items-center justify-center rounded-md border border-border bg-surface text-fg-muted shadow-sm hover:bg-hover hover:text-fg pointer-coarse:size-9"
									>
										<Icon name="pencil" class="size-3.5" />
									</button>
								{/if}
							{/snippet}
						</MessageBubble>
					{/if}
				{/each}
			</div>

			<MessageInput bind:value={currentInput} disabled={loading || hasOpenAiKey === false} onSend={() => sendMessage()} />
		{:else}
			<div class="flex flex-1 items-center justify-center">
				<p class="text-base text-fg-muted">Elige una simulación de la lista.</p>
			</div>
		{/if}
	</div>
</div>
