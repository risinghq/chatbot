<script lang="ts">
import { onMount } from "svelte";
import { fetchApi } from "#lib/utils/api.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import type { TestPersona } from "@vendeya/types";

let personas = $state<TestPersona[]>([]);
let loading = $state(true);

async function loadPersonas() {
  loading = true;
  try {
    personas = await fetchApi<TestPersona[]>("/api/simulator/personas");
  } catch (error) {
    console.error("Failed to load personas:", error);
  } finally {
    loading = false;
  }
}

async function deletePersona(personaId: string) {
  if (!confirm("¿Eliminar esta persona de prueba?")) return;

  loading = true;
  try {
    await fetchApi(`/api/simulator/personas/${personaId}`, {
      method: "DELETE",
    });
    await loadPersonas();
  } catch (error) {
    console.error("Failed to delete persona:", error);
    alert("Error al eliminar persona");
  } finally {
    loading = false;
  }
}

onMount(loadPersonas);

const segmentLabels: Record<string, string> = {
  fnb: "FNB",
  gaso: "GASO",
  not_eligible: "No elegible",
};

const columns = [
  { header: "Nombre", cell: nameCell },
  { header: "Segmento", cell: segmentCell },
  { header: "Cliente", cell: clientCell },
  { header: "Crédito", cell: creditCell },
  { header: "", align: "right" as const, cell: actionsCell },
];
</script>

<PageTitle title="Perfiles de cliente" />

<div class="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
	<PageHeader title="Perfiles de cliente de prueba" subtitle="Los clientes que el simulador usa para conversar con el bot.">
		{#snippet actions()}
			<Button href="/dashboard/personas/create">Nueva persona</Button>
		{/snippet}
	</PageHeader>

	<div class="rounded-md border border-border bg-surface">
		{#if !loading && personas.length === 0}
			<EmptyState title="Sin personas de prueba" description="Crea un perfil para simular conversaciones con el bot.">
				{#snippet action()}
					<Button href="/dashboard/personas/create" variant="secondary">Crear primera persona</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<DataTable data={personas} {columns} loading={loading && personas.length === 0} />
		{/if}
	</div>
</div>

{#snippet nameCell(p: TestPersona)}
	<div class="text-fg">{p.name}</div>
	<div class="max-w-xs truncate text-sm text-fg-muted">{p.description}</div>
{/snippet}

{#snippet segmentCell(p: TestPersona)}
	<Badge>{segmentLabels[p.segment] ?? p.segment}</Badge>
{/snippet}

{#snippet clientCell(p: TestPersona)}
	<div class="text-fg">{p.clientName}</div>
	<div class="font-mono text-sm text-fg-muted">DNI {p.dni}</div>
{/snippet}

{#snippet creditCell(p: TestPersona)}
	<div class="text-fg tabular-nums">S/ {p.creditLine.toLocaleString()}</div>
	{#if p.nse}
		<div class="text-sm text-fg-muted">NSE {p.nse}</div>
	{/if}
{/snippet}

{#snippet actionsCell(p: TestPersona)}
	<Button variant="ghost" size="sm" aria-label="Eliminar {p.name}" onclick={() => deletePersona(p.id)} disabled={loading}>
		<Icon name="trash" />
	</Button>
{/snippet}
