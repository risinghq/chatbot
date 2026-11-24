<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import { goto } from "$app/navigation";
import type { Conversation, ConversationMessage, Order } from "@vendeya/types";
import { fetchApi } from "#lib/utils/api.js";
import {
  acceptAssignment,
  releaseConversation,
  takeOverConversation,
  type ConversationActionContext,
} from "#lib/utils/conversation-actions.js";
import { formatPhone, formatDateTime } from "#lib/utils/formatters.js";
import { toast } from "#lib/state/toast.svelte.js";
import { auth } from "#lib/state/auth.svelte.js";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Button from "#lib/components/ui/button.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import MessageThread from "#lib/components/conversations/message-thread.svelte";
import MessageInput from "#lib/components/conversations/message-input.svelte";
import { orderLabel, orderStatusLabel } from "#lib/utils/order-status.js";
import type { PageData } from "./$types";

interface Props {
  data: PageData;
}
let { data }: Props = $props();

// Core state - initialized from data, can be refreshed via API
let conversation = $state<Conversation | null>(null);
let messages = $state<ConversationMessage[]>([]);
let messageText = $state("");
const order = $derived<Order | null>(data.order ?? null);

// Initialize state from server data
$effect(() => {
  conversation = data.conversation;
  messages = data.messages || [];
});

/**
 * Every write below addresses the conversation by phone number, which is only
 * half its identity: the same contact can be talking to two of the business's
 * numbers. The channel account from the loaded conversation disambiguates.
 */
const channelQuery = $derived(
  conversation?.channel_account_id
    ? `?channel=${encodeURIComponent(conversation.channel_account_id)}`
    : "",
);

const isHumanTakeover = $derived(conversation?.status === "human_takeover");
// The agent clears `assignment_notified_at` by taking the conversation over.
const isPendingAssignment = $derived(
  conversation?.assigned_agent && conversation?.assignment_notified_at,
);
const isAssignedToCurrentUser = $derived(
  conversation?.assigned_agent === data.user?.id,
);

/** Shared context keeps action failures in the page's toast flow. */
function actionContext(current: Conversation): ConversationActionContext {
  return {
    phoneNumber: current.phone_number,
    channelQuery,
    refresh: refreshConversation,
    notify: toast,
  };
}

async function handleTakeover() {
  if (!conversation) return;
  await takeOverConversation(actionContext(conversation));
}

async function handleAcceptAssignment() {
  if (!conversation) return;
  await acceptAssignment(actionContext(conversation));
}

async function handleDeclineAssignment() {
  if (!conversation) return;
  try {
    await fetchApi(
      `/api/conversations/${conversation.phone_number}/decline-assignment${channelQuery}`,
      {
        method: "POST",
      },
    );
    toast.info("Asignación rechazada. Se asignará a otro agente.");
    goto(businessPath("/conversations"));
  } catch (error) {
    console.error("Failed to decline:", error);
    toast.error("Error al rechazar asignación");
  }
}

async function handleRelease() {
  if (!conversation) return;
  await releaseConversation(actionContext(conversation));
}

async function handleSendMessage() {
  if (!(conversation && messageText.trim())) return;

  await fetchApi(
    `/api/conversations/${conversation.phone_number}/message${channelQuery}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: messageText }),
    },
  );

  messageText = "";
  await refreshConversation();
}

async function refreshConversation() {
  if (!conversation) return;
  const detail = await fetchApi<any>(
    `/api/conversations/${conversation.phone_number}${channelQuery}`,
  );
  conversation = detail.conversation;
  messages = detail.messages;
}

function goBack() {
  goto(businessPath("/conversations"));
}
</script>

<PageTitle title={conversation?.customer_name || formatPhone(conversation?.phone_number || "")} />

{#snippet sectionHeading(title: string)}
	<h2 class="mb-3 text-md font-medium text-fg">{title}</h2>
{/snippet}

{#if !conversation}
	<Page width="narrow">
		<EmptyState
			title="Conversación no encontrada"
			description="Puede que el cliente haya escrito a otro número del negocio."
		>
			{#snippet action()}
				<Button variant="secondary" size="sm" onclick={goBack}>Volver a conversaciones</Button>
			{/snippet}
		</EmptyState>
	</Page>
{:else}
	<!-- From lg up the thread and the side panel scroll on their own; below lg the page scrolls. -->
	<div class="flex flex-col lg:h-dvh lg:overflow-hidden">
		<header class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-subtle bg-surface px-4 py-2 md:min-h-12">
			<a
				href="{businessPath()}/conversations"
				aria-label="Volver a conversaciones"
				class="-ml-1 inline-flex size-8 items-center justify-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg pointer-coarse:size-11"
			>
				<Icon name="arrow" class="size-4 rotate-180" />
			</a>
			<div class="min-w-0 flex-1">
				<h1 class="truncate text-md font-medium text-fg">
					{conversation.customer_name || formatPhone(conversation.phone_number)}
				</h1>
				{#if conversation.customer_name}
					<p class="font-mono text-sm text-fg-muted">{formatPhone(conversation.phone_number)}</p>
				{/if}
			</div>
			{#if isHumanTakeover}
				<Badge variant="error">Intervención activa</Badge>
				<Button variant="secondary" size="sm" onclick={handleRelease}>Devolver al bot</Button>
			{:else}
				<Badge>Bot</Badge>
				<Button variant="secondary" size="sm" onclick={handleTakeover}>Intervenir</Button>
			{/if}
		</header>

		{#if isPendingAssignment && isAssignedToCurrentUser && auth.isSalesAgent}
			<div class="shrink-0 border-b border-border-subtle p-3">
				<Banner tone="info" title="Nueva asignación de cliente">
					Te asignaron este cliente. Acepta para atenderlo o rechaza para reasignarlo.
					{#snippet action()}
						<div class="flex gap-2">
							<Button size="sm" variant="secondary" onclick={handleDeclineAssignment}>Rechazar</Button>
							<Button size="sm" onclick={handleAcceptAssignment}>Aceptar</Button>
						</div>
					{/snippet}
				</Banner>
			</div>
		{/if}

		<div class="flex flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
			<section aria-label="Mensajes" class="flex h-[70dvh] min-w-0 flex-col bg-canvas lg:h-auto lg:min-h-0 lg:flex-1">
				<MessageThread {messages} />
				{#if isHumanTakeover}
					<MessageInput bind:value={messageText} onSend={handleSendMessage} />
				{/if}
			</section>

			<aside class="divide-y divide-border-subtle border-t border-border-subtle bg-surface lg:w-80 lg:overflow-y-auto lg:border-t-0 lg:border-l">
				{#if order}
					<div class="p-4">
						{@render sectionHeading("Último pedido")}
						<a
							href="{businessPath()}/orders/{order.id}"
							class="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-hover"
						>
							<span class="font-mono text-base text-fg">{orderLabel(order.number)}</span>
							<span class="flex items-center gap-1 text-sm text-fg-muted">{orderStatusLabel(order.status)} <Icon name="arrow" class="size-3.5" /></span>
						</a>
					</div>
				{/if}

				<div class="space-y-1 p-4 text-sm text-fg-muted">
					<p>Última actividad: {formatDateTime(conversation.last_activity_at)}</p>
					{#if conversation.ad_source_id}
						<p>Llegó por un anuncio: {conversation.ad_headline ?? conversation.ad_source_id}</p>
					{/if}
					{#if conversation.handover_reason}
						<p class="text-danger-text">Motivo de escalamiento: {conversation.handover_reason}</p>
					{/if}
				</div>
			</aside>
		</div>
	</div>
{/if}
