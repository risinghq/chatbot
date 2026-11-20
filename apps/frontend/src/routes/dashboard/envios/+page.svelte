<script lang="ts">
import type { OrderStatus, ShipmentSummary } from "@vendeya/types";
import { goto } from "$app/navigation";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { formatDateTime, formatPhone } from "#lib/utils/formatters.js";
import {
  orderLabel,
  orderStatusLabel,
  orderStatusVariant,
  paymentStateLabels,
  paymentStateVariant,
} from "#lib/utils/order-status.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

type Group = {
  title: string;
  description: string;
  statuses: OrderStatus[];
};

/** Ordered as the work flows: prepare, hand over, follow. */
const groups: Group[] = [
  {
    title: "Por preparar",
    description: "Pedidos por confirmar o confirmados que aún no se empacan.",
    statuses: ["pending", "confirmed"],
  },
  {
    title: "Listos para enviar",
    description: "Empacados; falta entregarlos al courier o al repartidor.",
    statuses: ["packed"],
  },
  {
    title: "En camino",
    description: "Salieron del almacén y esperan la entrega.",
    statuses: ["shipped"],
  },
];

const grouped = $derived(
  groups.map((group) => ({
    ...group,
    rows: data.open.filter((s) => group.statuses.includes(s.order_status)),
  })),
);

const openColumns = [
  { header: "Pedido", cell: orderCell },
  { header: "Destinatario", cell: recipientCell },
  { header: "Dirección", cell: addressCell },
  { header: "Envío", cell: carrierCell },
  { header: "Pago", cell: paymentCell },
];

const deliveredColumns = [
  { header: "Pedido", cell: orderCell },
  { header: "Destinatario", cell: recipientCell },
  { header: "Dirección", cell: addressCell },
  { header: "Entregado", cell: deliveredCell },
];

function openOrder(s: ShipmentSummary) {
  goto(`/dashboard/orders/${s.order_id}`);
}
</script>

<PageTitle title="Envíos" />

<Page>
	<PageHeader title="Envíos" subtitle="Los pedidos que se entregan a domicilio, de la preparación a la entrega." />

	{#if data.open.length === 0 && data.delivered.length === 0}
		<div class="rounded-md border border-border bg-surface">
			<EmptyState
				title="Sin envíos"
				description="Un pedido con dirección de entrega aparece aquí. Los que se recogen en tienda se ven en Pedidos."
			/>
		</div>
	{:else}
		<div class="flex flex-col gap-6">
			{#each grouped as group (group.title)}
				<SectionShell title="{group.title} · {group.rows.length}" description={group.description}>
					{#if group.rows.length === 0}
						<p class="px-4 py-3 text-sm text-fg-muted">Nada por ahora.</p>
					{:else}
						<DataTable data={group.rows} columns={openColumns} onRowClick={openOrder} />
					{/if}
				</SectionShell>
			{/each}

			{#if data.delivered.length > 0}
				<SectionShell title="Entregados" description="Los últimos envíos que llegaron a su destino.">
					<DataTable data={data.delivered} columns={deliveredColumns} onRowClick={openOrder} />
				</SectionShell>
			{/if}
		</div>
	{/if}
</Page>

{#snippet orderCell(s: ShipmentSummary)}
	<a href="/dashboard/orders/{s.order_id}" class="font-mono whitespace-nowrap text-fg hover:underline">{orderLabel(s.order_number)}</a>
	{#if s.order_status === "pending"}
		<div class="mt-0.5"><Badge variant={orderStatusVariant(s.order_status)}>{orderStatusLabel(s.order_status)}</Badge></div>
	{/if}
{/snippet}

{#snippet recipientCell(s: ShipmentSummary)}
	<div class="text-fg">{s.recipient_name}</div>
	{#if s.recipient_phone ?? s.customer_phone}
		<div class="font-mono text-sm text-fg-muted">{formatPhone((s.recipient_phone ?? s.customer_phone)!)}</div>
	{/if}
{/snippet}

{#snippet addressCell(s: ShipmentSummary)}
	<div class="text-fg">{s.address_line}</div>
	{#if s.district || s.city || s.zone_name}
		<div class="text-sm text-fg-muted">
			{[s.district, s.city].filter(Boolean).join(", ")}{#if s.zone_name}{s.district || s.city ? " · " : ""}Zona {s.zone_name}{/if}
		</div>
	{/if}
{/snippet}

{#snippet carrierCell(s: ShipmentSummary)}
	{#if s.carrier}
		<div class="text-fg">{s.carrier}</div>
		{#if s.tracking_code}
			<div class="font-mono text-sm text-fg-muted">{s.tracking_code}</div>
		{/if}
	{:else}
		<span class="text-sm text-fg-muted">Sin courier</span>
	{/if}
{/snippet}

{#snippet paymentCell(s: ShipmentSummary)}
	<Badge variant={paymentStateVariant(s.payment_state)}>{paymentStateLabels[s.payment_state]}</Badge>
{/snippet}

{#snippet deliveredCell(s: ShipmentSummary)}
	<span class="text-sm whitespace-nowrap text-fg-muted tabular-nums">
		{s.delivered_at ? formatDateTime(s.delivered_at) : "—"}
	</span>
{/snippet}
