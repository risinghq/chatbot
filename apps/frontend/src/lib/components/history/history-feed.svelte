<script lang="ts">
import type { HistoryEntry } from "@vendeya/types";
import Banner from "#lib/components/ui/banner.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import { fetchApi } from "#lib/utils/api.js";
import type { HistoryPlace } from "#lib/utils/history.js";
import HistoryList from "./history-list.svelte";

/** The page size the history routes answer by default. */
const PAGE = 50;

let { endpoint, place }: { endpoint: string; place: HistoryPlace } = $props();

let entries = $state<HistoryEntry[]>([]);
let loading = $state(true);
let failed = $state(false);
let more = $state(false);

async function load(offset: number) {
  loading = true;
  failed = false;
  try {
    const page = await fetchApi<{ entries: HistoryEntry[] }>(endpoint, {
      params: { limit: String(PAGE), offset: String(offset) },
    });
    entries = offset === 0 ? page.entries : [...entries, ...page.entries];
    more = page.entries.length === PAGE;
  } catch {
    failed = true;
  } finally {
    loading = false;
  }
}

$effect(() => {
  load(0);
});
</script>

{#if failed}
	<Banner tone="danger" title="No se pudo cargar el historial" class="mb-4">
		{#snippet action()}
			<Button variant="secondary" onclick={() => load(entries.length)}>Reintentar</Button>
		{/snippet}
	</Banner>
{/if}

{#if entries.length > 0}
	<HistoryList {entries} {place} />
	{#if more}
		<div class="mt-4 flex justify-center">
			<Button variant="secondary" onclick={() => load(entries.length)} disabled={loading}>
				{loading ? "Cargando…" : "Ver más"}
			</Button>
		</div>
	{/if}
{:else if loading}
	<p class="py-10 text-center text-base text-fg-muted">Cargando…</p>
{:else if !failed}
	<EmptyState title="Todavía no hay historial" description="Aquí aparece lo que el equipo cambia, en orden." />
{/if}
