<script lang="ts">
import type { AssistantCall } from "@vendeya/types";
import { businessPath } from "#lib/state/business.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import { formatDateTime, formatPhone } from "#lib/utils/formatters.js";
import AssistantTabs from "#lib/components/assistant/assistant-tabs.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import Sheet from "#lib/components/ui/sheet.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

/** The page size the calls route answers by default. */
const PAGE = 50;

let calls = $state<AssistantCall[]>([]);
let loading = $state(true);
let failed = $state(false);
let more = $state(false);
let selected = $state<AssistantCall | null>(null);

async function load(offset: number) {
  loading = true;
  failed = false;
  try {
    const page = await fetchApi<{ calls: AssistantCall[] }>(
      "/api/assistant/calls",
      { params: { limit: String(PAGE), offset: String(offset) } },
    );
    calls = offset === 0 ? page.calls : [...calls, ...page.calls];
    more = page.calls.length === PAGE;
  } catch {
    failed = true;
  } finally {
    loading = false;
  }
}

$effect(() => {
  load(0);
});

const seconds = (ms: number | null) =>
  ms === null
    ? "–"
    : `${(ms / 1000).toLocaleString("es-PE", { maximumFractionDigits: 1 })} s`;

const columns = [
  { header: "Hora", cell: timeCell },
  { header: "Cliente", cell: customerCell },
  { header: "Resultado", cell: statusCell },
  { header: "Demora", cell: latencyCell },
  { header: "Tokens", cell: tokensCell },
];
</script>

<PageTitle title="Registro del asistente" />

<Page>
	<PageHeader
		title="Asistente"
		subtitle="Cada respuesta que el asistente pidió al modelo, con lo que leyó y lo que contestó."
	/>

	<AssistantTabs class="-mx-4 mb-6 border-b border-border-subtle px-4 md:mx-0 md:px-0" />

	{#if failed}
		<Banner tone="danger" title="No se pudo cargar el registro" class="mb-4">
			{#snippet action()}
				<Button variant="secondary" onclick={() => load(calls.length)}>Reintentar</Button>
			{/snippet}
		</Banner>
	{/if}

	<div class="overflow-hidden rounded-md border border-border bg-surface">
		<DataTable
			data={calls}
			{columns}
			loading={loading && calls.length === 0}
			onRowClick={(call: AssistantCall) => (selected = call)}
			emptyMessage="El asistente todavía no ha respondido a nadie."
		/>
	</div>

	{#if more}
		<div class="mt-4 flex justify-center">
			<Button variant="secondary" onclick={() => load(calls.length)} disabled={loading}>
				{loading ? "Cargando…" : "Ver más"}
			</Button>
		</div>
	{/if}
</Page>

<Sheet
	open={selected !== null}
	onclose={() => (selected = null)}
	title={selected ? `+${selected.phone_number}` : ""}
	description={selected ? formatDateTime(selected.created_at) : ""}
>
	{#if selected}
		<div class="flex flex-col gap-5">
			<dl class="grid grid-cols-3 gap-4 rounded-md border border-border-subtle bg-sunken p-3">
				{@render field("Modelo", selected.model)}
				{@render field("Demora", seconds(selected.latency_ms))}
				{@render field("Tokens", selected.tokens_total?.toLocaleString("es-PE") ?? "–")}
			</dl>
			<a class="text-base text-fg underline underline-offset-2" href={businessPath(`/conversations/${selected.phone_number}`)}>
				Abrir la conversación
			</a>
			{#if selected.error_message}
				<Banner tone="danger" title="El modelo falló">{selected.error_message}</Banner>
			{/if}
			{@render block("Lo que leyó", selected.prompt)}
			{@render block("Lo que contestó", selected.response || "Sin respuesta")}
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

{#snippet timeCell(call: AssistantCall)}
	<span class="text-sm whitespace-nowrap text-fg-muted tabular-nums">{formatDateTime(call.created_at)}</span>
{/snippet}

{#snippet customerCell(call: AssistantCall)}
	<span class="text-fg tabular-nums">{formatPhone(call.phone_number)}</span>
{/snippet}

{#snippet statusCell(call: AssistantCall)}
	{#if call.status === "error"}
		<Badge variant="error">Falló</Badge>
	{:else}
		<Badge variant="success">Respondió</Badge>
	{/if}
{/snippet}

{#snippet latencyCell(call: AssistantCall)}
	<span class="text-sm text-fg-muted tabular-nums">{seconds(call.latency_ms)}</span>
{/snippet}

{#snippet tokensCell(call: AssistantCall)}
	<span class="text-sm text-fg-muted tabular-nums">{call.tokens_total?.toLocaleString("es-PE") ?? "–"}</span>
{/snippet}
