<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Select from "#lib/components/ui/select.svelte";
import { fieldStyles } from "#lib/components/ui/field-styles.js";
import { auth } from "#lib/state/auth.svelte.js";
import { formatPhone, formatDateTime } from "#lib/utils/formatters.js";
import { formatCents } from "#lib/utils/money.js";
import {
  orderLabel,
  orderStatusLabels,
  orderStatusLabel,
  orderStatusVariant,
  paymentStateLabels,
  paymentStateVariant,
} from "#lib/utils/order-status.js";
import type { PageData } from "./$types";

type Order = PageData["orders"][number];

let { data }: { data: PageData } = $props();

const query = page.url.searchParams;
let statusFilter = $state(query.get("status") ?? "");
let startDate = $state(query.get("startDate") ?? "");
let endDate = $state(query.get("endDate") ?? "");

const statusItems = [
  { value: "", label: "Todos" },
  ...Object.entries(orderStatusLabels).map(([value, label]) => ({
    value,
    label,
  })),
];

const columns = [
  { header: "Pedido", cell: numberCell },
  { header: "Cliente", cell: customerCell },
  { header: "Total", align: "right" as const, cell: totalCell },
  { header: "Pago", cell: paymentCell },
  { header: "Estado", cell: statusCell },
  { header: "Fecha", cell: dateCell },
];

function applyFilters() {
  const params = new URLSearchParams();
  if (statusFilter) params.append("status", statusFilter);
  if (startDate) params.append("startDate", startDate);
  if (endDate) params.append("endDate", endDate);

  const queryString = params.toString();
  goto(`${businessPath()}/orders${queryString ? `?${queryString}` : ""}`);
}

function clearFilters() {
  statusFilter = "";
  startDate = "";
  endDate = "";
  goto(businessPath("/orders"));
}
</script>

<PageTitle title="Pedidos" />

<Page>
	<PageHeader title="Pedidos" subtitle="Lo que tus clientes compraron, del pago a la entrega.">
		{#snippet actions()}
			{#if auth.canTakeOrders}
				<Button href="{businessPath()}/orders/nuevo">Nuevo pedido</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.metrics}
		{@const m = data.metrics}
		<div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
			{@render stat("Por confirmar", String(m.byStatus.pending), "Pedidos nuevos")}
			{@render stat("Por despachar", String(m.byStatus.confirmed + m.byStatus.packed), "Confirmados o empacados")}
			{@render stat("Por cobrar", `S/ ${formatCents(m.outstandingCents)}`, "Saldo de pedidos activos")}
			{@render stat("Entregado", `S/ ${formatCents(m.deliveredCentsLast30Days)}`, "Últimos 30 días")}
		</div>
	{/if}

	<div class="rounded-md border border-border bg-surface">
		<div class="grid grid-cols-1 items-end gap-x-3 border-b border-border-subtle p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
			<FormField label="Estado" for="status-filter" class="mb-3! lg:mb-0!">
				<Select id="status-filter" bind:value={statusFilter} items={statusItems} />
			</FormField>
			<FormField label="Desde" for="start-date-filter" class="mb-3! lg:mb-0!">
				<input id="start-date-filter" type="date" bind:value={startDate} class="{fieldStyles(false)} h-8 pointer-coarse:h-11" />
			</FormField>
			<FormField label="Hasta" for="end-date-filter" class="mb-3! lg:mb-0!">
				<input id="end-date-filter" type="date" bind:value={endDate} class="{fieldStyles(false)} h-8 pointer-coarse:h-11" />
			</FormField>
			<div class="flex gap-2">
				<Button size="sm" onclick={applyFilters}>Aplicar</Button>
				<Button size="sm" variant="ghost" onclick={clearFilters}>Limpiar</Button>
			</div>
		</div>

		{#if data.orders.length === 0}
			<EmptyState
				title="Sin pedidos"
				description="Los pedidos aparecen aquí cuando el asistente o tu equipo los registra."
			/>
		{:else}
			<DataTable data={data.orders} {columns} onRowClick={(o) => goto(`${businessPath()}/orders/${o.id}`)} />
		{/if}
	</div>
</Page>

{#snippet stat(label: string, value: string, hint: string)}
	<div class="rounded-md border border-border bg-surface px-4 py-3">
		<p class="text-sm text-fg-muted">{label}</p>
		<p class="mt-1 text-xl text-fg tabular-nums">{value}</p>
		<p class="mt-0.5 text-sm text-fg-muted">{hint}</p>
	</div>
{/snippet}

{#snippet numberCell(o: Order)}
	<a href="{businessPath()}/orders/{o.id}" class="font-mono whitespace-nowrap text-fg hover:underline">{orderLabel(o.number)}</a>
{/snippet}

{#snippet customerCell(o: Order)}
	<div class="text-fg">{o.customer_name}</div>
	{#if o.customer_phone}
		<div class="font-mono text-sm text-fg-muted">{formatPhone(o.customer_phone)}</div>
	{/if}
{/snippet}

{#snippet totalCell(o: Order)}
	<span class="whitespace-nowrap text-fg tabular-nums">S/ {formatCents(o.total_cents)}</span>
{/snippet}

{#snippet paymentCell(o: Order)}
	<Badge variant={paymentStateVariant(o.payment_state)}>{paymentStateLabels[o.payment_state]}</Badge>
{/snippet}

{#snippet statusCell(o: Order)}
	<Badge variant={orderStatusVariant(o.status)}>{orderStatusLabel(o.status)}</Badge>
{/snippet}

{#snippet dateCell(o: Order)}
	<span class="text-sm text-fg-muted tabular-nums">{formatDateTime(o.created_at)}</span>
{/snippet}
