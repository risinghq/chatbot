<script lang="ts">
import { invalidateAll } from "$app/navigation";
import type { SystemLogEntry } from "@vendeya/types";
import { formatDateTime } from "#lib/utils/formatters.js";
import Badge from "#lib/components/ui/badge.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import Sheet from "#lib/components/ui/sheet.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

let { data } = $props();

let loading = $state(false);
let selected = $state<SystemLogEntry | null>(null);
let sheetOpen = $state(false);

const sourceLabels: Record<string, string> = { llm: "IA", audit: "Auditoría" };
const statusLabels: Record<string, string> = {
  success: "Correcto",
  error: "Error",
  info: "Info",
};
const statusDots: Record<string, string> = {
  success: "bg-success",
  error: "bg-danger",
  info: "bg-info",
};

async function refresh() {
  loading = true;
  await invalidateAll();
  loading = false;
}

function openDetails(log: SystemLogEntry) {
  selected = log;
  sheetOpen = true;
}

const columns = [
  { header: "Estado", class: "w-16", cell: statusCell },
  { header: "Hora", cell: timeCell },
  { header: "Fuente", cell: sourceCell },
  { header: "Evento", cell: eventCell },
  { header: "Resumen", cell: summaryCell },
  { header: "Actor", cell: actorCell },
];
</script>

<PageTitle title="Actividad" />

<div class="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
	<PageHeader
		title="Actividad"
		subtitle="Llamadas a la IA y acciones del equipo, en orden de llegada. Elige una fila para ver el detalle."
	>
		{#snippet actions()}
			<Button variant="secondary" onclick={refresh} disabled={loading}>
				{loading ? "Actualizando…" : "Actualizar"}
			</Button>
		{/snippet}
	</PageHeader>

	{#if data.error}
		<Banner tone="danger" title="No se pudo cargar la actividad" class="mb-4">
			Vuelve a intentarlo con Actualizar.
		</Banner>
	{/if}

	<div class="overflow-hidden rounded-md border border-border bg-surface">
		<DataTable
			data={data.logs}
			{columns}
			{loading}
			onRowClick={openDetails}
			emptyMessage="Todavía no hay actividad."
		/>
	</div>
</div>

<Sheet
	open={sheetOpen}
	onclose={() => (sheetOpen = false)}
	title={selected?.event ?? "Detalle"}
	description={selected ? formatDateTime(selected.timestamp) : ""}
>
	{#if selected}
		<div class="flex flex-col gap-5">
			<dl class="grid grid-cols-2 gap-4 rounded-md border border-border-subtle bg-sunken p-3">
				{@render field("Fuente", sourceLabels[selected.source] ?? selected.source)}
				{@render field("Estado", statusLabels[selected.status] ?? selected.status)}
				{@render field("Actor", selected.actor)}
				<div class="min-w-0">
					<dt class="text-sm text-fg-muted">Id</dt>
					<dd class="truncate font-mono text-xs text-fg" title={selected.id}>{selected.id}</dd>
				</div>
			</dl>

			{#if selected.source === "llm"}
				{#if selected.original_data?.error_message}
					<Banner tone="danger" title="Error">{selected.original_data.error_message}</Banner>
				{/if}
				{@render block("Prompt", selected.original_data?.prompt ?? "")}
				{@render block("Respuesta", selected.original_data?.response || "Sin respuesta")}
			{/if}

			{#if selected.metadata && Object.keys(selected.metadata).length > 0}
				{@render block("Metadata", JSON.stringify(selected.metadata, null, 2))}
			{/if}
		</div>
	{/if}
</Sheet>

{#snippet field(label: string, value: string)}
	<div class="min-w-0">
		<dt class="text-sm text-fg-muted">{label}</dt>
		<dd class="truncate text-base text-fg">{value}</dd>
	</div>
{/snippet}

{#snippet block(label: string, value: string)}
	<section>
		<h3 class="mb-1.5 text-sm text-fg-muted">{label}</h3>
		<pre class="overflow-x-auto rounded-sm border border-border-subtle bg-sunken p-3 font-mono text-xs whitespace-pre-wrap text-fg">{value}</pre>
	</section>
{/snippet}

{#snippet statusCell(item: SystemLogEntry)}
	<span class="flex items-center">
		<span class="size-2 rounded-full {statusDots[item.status] ?? 'bg-fg-subtle'}" aria-hidden="true"></span>
		<span class="sr-only">{statusLabels[item.status] ?? item.status}</span>
	</span>
{/snippet}

{#snippet timeCell(item: SystemLogEntry)}
	<span class="text-sm whitespace-nowrap text-fg-muted tabular-nums">{formatDateTime(item.timestamp)}</span>
{/snippet}

{#snippet sourceCell(item: SystemLogEntry)}
	<Badge variant={item.source === "llm" ? "accent" : "default"}>{sourceLabels[item.source] ?? item.source}</Badge>
{/snippet}

{#snippet eventCell(item: SystemLogEntry)}
	<span class="font-mono text-sm text-fg">{item.event}</span>
{/snippet}

{#snippet summaryCell(item: SystemLogEntry)}
	<span class="block max-w-md truncate text-fg-muted" title={item.summary}>{item.summary}</span>
{/snippet}

{#snippet actorCell(item: SystemLogEntry)}
	<span class="text-sm text-fg-muted">{item.actor}</span>
{/snippet}
