<script lang="ts">
import HistoryFeed from "#lib/components/history/history-feed.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
</script>

<PageTitle title="Historial" />

<Page>
	<PageHeader
		title="Historial"
		subtitle="Lo que se cambió fuera de los negocios: ajustes de la plataforma, cuentas y tokens."
	/>
	<HistoryFeed endpoint="/api/platform/history" place={{ platform: true }} />
</Page>
