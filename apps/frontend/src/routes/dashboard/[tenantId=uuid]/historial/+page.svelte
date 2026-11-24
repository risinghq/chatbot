<script lang="ts">
import { page } from "$app/state";
import HistoryFeed from "#lib/components/history/history-feed.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

const tenantId = $derived(page.params.tenantId ?? "");
</script>

<PageTitle title="Historial" />

<Page>
	<PageHeader title="Historial" subtitle="Lo que el equipo cambió en el negocio, del más reciente al más antiguo." />
	{#key tenantId}
		<HistoryFeed endpoint="/api/history" place={{ tenantId }} />
	{/key}
</Page>
