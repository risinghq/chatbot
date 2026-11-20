<script lang="ts">
import { goto } from "$app/navigation";
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
import {
  formatPhone,
  formatPrice,
  formatDateTime,
} from "#lib/utils/formatters.js";
import {
  orderStatusLabels,
  orderStatusLabel,
  orderStatusVariant,
} from "#lib/utils/order-status.js";
import type { PageData } from "./$types";

type Order = PageData["orders"][number];

let { data }: { data: PageData } = $props();

let statusFilter = $state("");
let startDate = $state("");
let endDate = $state("");

const statusItems = [
  { value: "", label: "Todos" },
  ...Object.entries(orderStatusLabels).map(([value, label]) => ({
    value,
    label,
  })),
];

const columns = [
  { header: "Orden", cell: numberCell },
  { header: "Cliente", cell: clientCell },
  { header: "Monto", align: "right" as const, cell: amountCell },
  { header: "Estado", cell: statusCell },
  { header: "Fecha", cell: dateCell },
];

function applyFilters() {
  const params = new URLSearchParams();
  if (statusFilter) params.append("status", statusFilter);
  if (startDate) params.append("startDate", startDate);
  if (endDate) params.append("endDate", endDate);

  const queryString = params.toString();
  goto(`/dashboard/orders${queryString ? `?${queryString}` : ""}`);
}

function clearFilters() {
  statusFilter = "";
  startDate = "";
  endDate = "";
  goto("/dashboard/orders");
}
</script>

<PageTitle title="Órdenes" />

<Page>
	<PageHeader title="Órdenes" subtitle="Pedidos creados desde las conversaciones, de la aprobación a la entrega." />

	{#if data.metrics}
		<div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
			{@render stat("Pendientes", String(data.metrics.pendingCount), "Requieren aprobación")}
			{@render stat("Entregadas", String(data.metrics.deliveredCount), `${data.metrics.approvalRate.toFixed(1)}% aprobadas`)}
			{@render stat("Ingresos", `S/ ${formatPrice(data.metrics.totalRevenue)}`, `Ticket promedio S/ ${formatPrice(data.metrics.avgOrderValue)}`)}
			{@render stat("Este mes", `S/ ${formatPrice(data.metrics.revenueThisMonth)}`, `${data.metrics.rejectionRate.toFixed(1)}% rechazadas`)}
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
				title="Sin órdenes"
				description="Las órdenes aparecen aquí cuando un agente las crea desde una conversación."
			/>
		{:else}
			<DataTable data={data.orders} {columns} onRowClick={(o) => goto(`/dashboard/orders/${o.id}`)} />
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
	<a href="/dashboard/orders/{o.id}" class="font-mono whitespace-nowrap text-fg hover:underline">{o.order_number}</a>
{/snippet}

{#snippet clientCell(o: Order)}
	<div class="text-fg">{o.client_name}</div>
	<div class="font-mono text-sm text-fg-muted">{formatPhone(o.conversation_phone)}</div>
{/snippet}

{#snippet amountCell(o: Order)}
	<span class="whitespace-nowrap text-fg tabular-nums">S/ {formatPrice(o.total_amount)}</span>
{/snippet}

{#snippet statusCell(o: Order)}
	<Badge variant={orderStatusVariant(o.status)}>{orderStatusLabel(o.status)}</Badge>
{/snippet}

{#snippet dateCell(o: Order)}
	<span class="text-sm text-fg-muted tabular-nums">{formatDateTime(o.created_at)}</span>
{/snippet}
