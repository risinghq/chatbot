<script lang="ts">
import { goto } from "$app/navigation";
import type {
  Conversation,
  ConversationMessage,
  SaleStatus,
  Order,
} from "@vendeya/types";
import { fetchApi } from "#lib/utils/api.js";
import {
  acceptAssignment,
  releaseConversation,
  takeOverConversation,
  type ConversationActionContext,
} from "#lib/utils/conversation-actions.js";
import {
  formatPhone,
  formatPrice,
  formatDateTime,
} from "#lib/utils/formatters.js";
import { toast } from "#lib/state/toast.svelte.js";
import { auth } from "#lib/state/auth.svelte.js";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Button from "#lib/components/ui/button.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import Input from "#lib/components/ui/input.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import MessageThread from "#lib/components/conversations/message-thread.svelte";
import MessageInput from "#lib/components/conversations/message-input.svelte";
import { phaseLabel } from "#lib/utils/conversation-phase.js";
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
let saving = $state(false);
const order = $derived<Order | null>(data.order ?? null);
let uploadingContract = $state(false);
let contractFile: File | null = $state(null);
let audioFile: File | null = $state(null);

// Agent editable fields
let agentNotes = $state("");
let saleStatus = $state<SaleStatus>("pending");
let deliveryAddress = $state("");
let deliveryReference = $state("");

// Initialize state from server data
$effect(() => {
  conversation = data.conversation;
  messages = data.messages || [];
  // Reset form fields when conversation changes
  agentNotes = data.conversation?.agent_notes || "";
  saleStatus = data.conversation?.sale_status || "pending";
  deliveryAddress = data.conversation?.delivery_address || "";
  deliveryReference = data.conversation?.delivery_reference || "";
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

const saleStatusOptions: { value: SaleStatus; label: string }[] = [
  { value: "pending", label: "Pendiente" },
  { value: "confirmed", label: "Confirmado" },
  { value: "rejected", label: "Rechazado" },
  { value: "no_answer", label: "Sin respuesta" },
];

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
    goto("/dashboard/conversations");
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

async function saveAgentData() {
  if (!conversation) return;
  saving = true;

  try {
    await fetchApi(
      `/api/conversations/${conversation.phone_number}/agent-data${channelQuery}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_notes: agentNotes,
          sale_status: saleStatus,
          delivery_address: deliveryAddress,
          delivery_reference: deliveryReference,
        }),
      },
    );
    await refreshConversation();
  } catch (error) {
    console.error("Failed to save:", error);
  } finally {
    saving = false;
  }
}

async function handleUploadContract() {
  if (!(contractFile && audioFile && conversation)) return;

  uploadingContract = true;
  try {
    const formData = new FormData();
    formData.append("contract", contractFile);
    formData.append("audio", audioFile);
    formData.append("clientName", conversation.client_name || "");

    await fetchApi(
      `/api/conversations/${conversation.phone_number}/upload-contract${channelQuery}`,
      {
        method: "POST",
        body: formData,
      },
    );

    toast.success("Contrato subido exitosamente. Supervisores notificados.");
    await refreshConversation();
    contractFile = null;
    audioFile = null;
  } catch (error) {
    console.error("Failed to upload contract:", error);
    toast.error("Error al subir contrato");
  } finally {
    uploadingContract = false;
  }
}

function goBack() {
  goto("/dashboard/conversations");
}
</script>

<PageTitle title={conversation?.client_name || formatPhone(conversation?.phone_number || "")} />

{#snippet sectionHeading(title: string)}
	<h2 class="mb-3 text-md font-medium text-fg">{title}</h2>
{/snippet}

{#snippet fileField(id: string, label: string, accept: string, onpick: (file: File | null) => void)}
	<FormField {label} for={id}>
		<input
			{id}
			type="file"
			{accept}
			onchange={(e) => onpick(e.currentTarget.files?.[0] || null)}
			class="block w-full text-base text-fg-muted file:mr-3 file:h-8 file:cursor-pointer file:rounded-sm file:border file:border-border file:bg-surface file:px-3 file:text-base file:font-medium file:text-fg hover:file:bg-hover"
		/>
	</FormField>
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
				href="/dashboard/conversations"
				aria-label="Volver a conversaciones"
				class="-ml-1 inline-flex size-8 items-center justify-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg pointer-coarse:size-11"
			>
				<Icon name="arrow" class="size-4 rotate-180" />
			</a>
			<div class="min-w-0 flex-1">
				<h1 class="truncate text-md font-medium text-fg">
					{conversation.client_name || formatPhone(conversation.phone_number)}
				</h1>
				{#if conversation.client_name}
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
					Este cliente está listo para contratar. Acepta para continuar o rechaza para reasignarlo.
					{#snippet action()}
						<div class="flex gap-2">
							<Button size="sm" variant="secondary" onclick={handleDeclineAssignment}>Rechazar</Button>
							<Button size="sm" onclick={handleAcceptAssignment}>Aceptar</Button>
						</div>
					{/snippet}
				</Banner>
			</div>
		{/if}

		<dl class="flex shrink-0 flex-wrap gap-x-6 gap-y-1 border-b border-border-subtle bg-surface px-4 py-2 text-sm">
			{#each [
				["DNI", conversation.dni || "—"],
				["Segmento", conversation.segment?.toUpperCase() || "—"],
				["Crédito", conversation.credit_line ? `S/ ${formatPrice(conversation.credit_line)}` : "—"],
				["NSE", conversation.nse || "—"],
				["Estado", phaseLabel(conversation.current_state)],
			] as [term, value] (term)}
				<div class="flex gap-1.5">
					<dt class="text-fg-muted">{term}</dt>
					<dd class="text-fg">{value}</dd>
				</div>
			{/each}
		</dl>

		<div class="flex flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
			<section aria-label="Mensajes" class="flex h-[70dvh] min-w-0 flex-col bg-canvas lg:h-auto lg:min-h-0 lg:flex-1">
				<MessageThread {messages} />
				{#if isHumanTakeover}
					<MessageInput bind:value={messageText} onSend={handleSendMessage} />
				{/if}
			</section>

			<aside class="divide-y divide-border-subtle border-t border-border-subtle bg-surface lg:w-80 lg:overflow-y-auto lg:border-t-0 lg:border-l">
				<fieldset class="p-4">
					<legend class="contents">{@render sectionHeading("Estado de venta")}</legend>
					<div class="flex flex-col">
						{#each saleStatusOptions as option (option.value)}
							<label class="-mx-2 flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-base text-fg hover:bg-hover pointer-coarse:h-11">
								<input
									type="radio"
									name="saleStatus"
									value={option.value}
									bind:group={saleStatus}
									class="size-4 border-border bg-surface text-accent"
								/>
								{option.label}
							</label>
						{/each}
					</div>
				</fieldset>

				{#if saleStatus === "confirmed"}
					<div class="p-4">
						{@render sectionHeading("Datos de entrega")}
						<FormField label="Dirección" for="delivery-address">
							<Textarea id="delivery-address" bind:value={deliveryAddress} rows={2} placeholder="Av. Lima 123, San Isidro" />
						</FormField>
						<FormField label="Referencia" for="delivery-reference" class="mb-0!">
							<Input id="delivery-reference" bind:value={deliveryReference} placeholder="Frente al parque" />
						</FormField>
					</div>
				{/if}

				<div class="p-4">
					<FormField label="Observaciones" for="agent-notes" class="mb-0!">
						<Textarea id="agent-notes" bind:value={agentNotes} rows={4} placeholder="Notas sobre la llamada, productos de interés…" />
					</FormField>
				</div>

				{#if conversation.products_interested && conversation.products_interested !== "[]"}
					<div class="p-4">
						{@render sectionHeading("Productos de interés")}
						<p class="text-sm break-words text-fg-muted">{conversation.products_interested}</p>
					</div>
				{/if}

				<div class="p-4">
					<Button onclick={saveAgentData} disabled={saving} class="w-full">
						{saving ? "Guardando…" : "Guardar cambios"}
					</Button>
				</div>

				{#if isHumanTakeover && !conversation.recording_uploaded_at && auth.isSalesAgent}
					<div class="p-4">
						{@render sectionHeading("Subir contrato")}
						<p class="-mt-2 mb-3 text-base text-fg-muted">
							Sube el contrato firmado y la grabación de la llamada para completar la venta.
						</p>
						{@render fileField("contract-file", "Contrato (PDF o DOCX)", ".pdf,.docx,.doc", (f) => (contractFile = f))}
						{@render fileField("audio-file", "Grabación de audio", ".mp3,.m4a,.wav,.ogg", (f) => (audioFile = f))}
						<Button
							variant="secondary"
							onclick={handleUploadContract}
							disabled={!contractFile || !audioFile || uploadingContract}
							class="w-full"
						>
							{uploadingContract ? "Subiendo…" : "Subir contrato y grabación"}
						</Button>
					</div>
				{/if}

				{#if order}
					<div class="p-4">
						{@render sectionHeading("Último pedido")}
						<a
							href="/dashboard/orders/{order.id}"
							class="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-hover"
						>
							<span class="font-mono text-base text-fg">{orderLabel(order.number)}</span>
							<span class="flex items-center gap-1 text-sm text-fg-muted">{orderStatusLabel(order.status)} <Icon name="arrow" class="size-3.5" /></span>
						</a>
					</div>
				{/if}

				<div class="space-y-1 p-4 text-sm text-fg-muted">
					<p>Última actividad: {formatDateTime(conversation.last_activity_at)}</p>
					{#if conversation.handover_reason}
						<p class="text-danger-text">Motivo de escalamiento: {conversation.handover_reason}</p>
					{/if}
				</div>
			</aside>
		</div>
	</div>
{/if}
