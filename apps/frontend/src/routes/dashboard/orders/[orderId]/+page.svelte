<script lang="ts">
import { invalidateAll } from "$app/navigation";
import type { OrderStatus } from "@vendeya/types";
import { fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import { auth } from "#lib/state/auth.svelte.js";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import {
  formatPhone,
  formatPrice,
  formatDateTime,
} from "#lib/utils/formatters.js";
import {
  orderStatusLabel,
  orderStatusVariant,
} from "#lib/utils/order-status.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let approvalNotes = $state("");
let processing = $state(false);

async function updateStatus(
  newStatus: OrderStatus,
  noteType?: "supervisor" | "calidda",
) {
  if (!data.order) return;

  if (newStatus.includes("rejected") && !approvalNotes.trim()) {
    toast.error("Debe ingresar una razón para el rechazo");
    return;
  }

  processing = true;
  try {
    await fetchApi(`/api/orders/${data.order.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: newStatus,
        notes: approvalNotes,
        noteType,
      }),
    });

    toast.success("Estado actualizado correctamente");
    approvalNotes = "";
    await invalidateAll();
  } catch (error) {
    console.error("Failed to update status:", error);
    toast.error("Error al actualizar el estado");
  } finally {
    processing = false;
  }
}

function parseProducts(productsJson: string) {
  try {
    const parsed = JSON.parse(productsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
</script>

<PageTitle title={data.order?.order_number || "Orden"} />

{#snippet card(title: string)}
	<h2 class="mb-3 text-md font-medium text-fg">{title}</h2>
{/snippet}

{#snippet field(label: string, value: string, mono = false)}
	<div>
		<dt class="text-sm text-fg-muted">{label}</dt>
		<dd class="mt-0.5 text-fg tabular-nums {mono ? 'font-mono' : ''}">{value}</dd>
	</div>
{/snippet}

<div class="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
	<a href="/dashboard/orders" class="mb-3 inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
		<Icon name="arrow" class="size-3.5 rotate-180" />
		Órdenes
	</a>

	{#if !data.order}
		<div class="rounded-md border border-border bg-surface">
			<EmptyState title="Orden no encontrada" description="Puede que la hayan eliminado o que el enlace esté mal.">
				{#snippet action()}
					<Button href="/dashboard/orders" variant="secondary">Volver a órdenes</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		{@const order = data.order}
		{@const products = parseProducts(order.products)}
		{@const canApproveSuper = auth.canApproveOrders}
		{@const canApproveCalidda = auth.canApproveCaliida}
		{@const open = order.status !== "delivered" && !order.status.includes("rejected")}
		{@const canAct =
			(order.status === "pending" && canApproveSuper) ||
			(order.status === "supervisor_approved" && canApproveCalidda) ||
			(order.status === "calidda_approved" && canApproveSuper)}

		<header class="mb-6 flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h1 class="font-mono text-xl text-fg">{order.order_number}</h1>
				<p class="mt-1 text-base text-fg-muted">{order.client_name}</p>
			</div>
			<Badge variant={orderStatusVariant(order.status)}>{orderStatusLabel(order.status)}</Badge>
		</header>

		<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
			<div class="divide-y divide-border-subtle rounded-md border border-border bg-surface lg:col-span-2">
				<section class="p-4">
					{@render card("Cliente")}
					<dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
						{@render field("Nombre", order.client_name)}
						{@render field("DNI", order.client_dni, true)}
						{@render field("Teléfono", formatPhone(order.conversation_phone), true)}
						<div>
							<dt class="text-sm text-fg-muted">Conversación</dt>
							<dd class="mt-0.5">
								<a
									href="/dashboard/conversations/{order.conversation_phone}?channel={order.channel_account_id}"
									class="text-accent-text hover:underline"
								>
									Abrir conversación
								</a>
							</dd>
						</div>
					</dl>
				</section>

				<section class="p-4">
					{@render card("Productos")}
					{#if products.length > 0}
						<ul class="divide-y divide-border-subtle">
							{#each products as product}
								<li class="flex items-baseline justify-between gap-4 py-2 first:pt-0">
									<span class="text-fg">{product.name || "Producto"}</span>
									{#if product.price}
										<span class="text-fg-muted tabular-nums">S/ {formatPrice(product.price)}</span>
									{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-fg-muted">La orden no lista productos.</p>
					{/if}
					<div class="mt-3 flex items-baseline justify-between border-t border-border-subtle pt-3">
						<span class="text-fg-muted">Total</span>
						<span class="text-md font-medium text-fg tabular-nums">S/ {formatPrice(order.total_amount)}</span>
					</div>
				</section>

				<section class="p-4">
					{@render card("Entrega")}
					<dl class="grid grid-cols-1 gap-3">
						{@render field("Dirección", order.delivery_address || "—")}
						{#if order.delivery_reference}
							{@render field("Referencia", order.delivery_reference)}
						{/if}
					</dl>
				</section>
			</div>

			<div class="flex flex-col gap-4">
				{#if open}
					<section class="rounded-md border border-border bg-surface p-4">
						{@render card("Aprobación")}
						{#if canAct}
							{#if order.status === "pending" || order.status === "supervisor_approved"}
								<FormField label="Notas (obligatorias para rechazar)" for="approval-notes">
									<Textarea id="approval-notes" bind:value={approvalNotes} rows={3} placeholder="Observaciones…" />
								</FormField>
							{/if}

							<div class="flex gap-2">
								{#if order.status === "pending"}
									<Button class="flex-1" onclick={() => updateStatus("supervisor_approved", "supervisor")} disabled={processing}>
										Aprobar
									</Button>
									<Button class="flex-1" variant="danger" onclick={() => updateStatus("supervisor_rejected", "supervisor")} disabled={processing}>
										Rechazar
									</Button>
								{:else if order.status === "supervisor_approved"}
									<Button class="flex-1" onclick={() => updateStatus("calidda_approved", "calidda")} disabled={processing}>
										Aprobar (Calidda)
									</Button>
									<Button class="flex-1" variant="danger" onclick={() => updateStatus("calidda_rejected", "calidda")} disabled={processing}>
										Rechazar
									</Button>
								{:else}
									<Button class="flex-1" onclick={() => updateStatus("delivered")} disabled={processing}>
										Marcar como entregada
									</Button>
								{/if}
							</div>
						{:else}
							<p class="text-fg-muted">Tu rol no puede aprobar la orden en este estado.</p>
						{/if}
					</section>
				{/if}

				<section class="rounded-md border border-border bg-surface p-4">
					{@render card("Historial")}
					<dl class="grid grid-cols-1 gap-3">
						{@render field("Creada", formatDateTime(order.created_at))}
						{@render field("Última actualización", formatDateTime(order.updated_at))}
						{#if order.assigned_agent}
							{@render field("Agente asignado", order.assigned_agent_name ?? "Usuario eliminado")}
						{/if}
					</dl>
				</section>

				{#if order.supervisor_notes || order.calidda_notes}
					<section class="rounded-md border border-border bg-surface p-4">
						{@render card("Notas")}
						<dl class="grid grid-cols-1 gap-3">
							{#if order.supervisor_notes}
								{@render field("Supervisor", order.supervisor_notes)}
							{/if}
							{#if order.calidda_notes}
								{@render field("Calidda", order.calidda_notes)}
							{/if}
						</dl>
					</section>
				{/if}
			</div>
		</div>
	{/if}
</div>
