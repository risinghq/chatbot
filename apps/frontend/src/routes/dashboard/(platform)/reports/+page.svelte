<script lang="ts">
import ReportOverview from "#lib/components/reports/report-overview.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
</script>

<PageTitle title="Reportes" />

<Page>
	<PageHeader title="Reportes" subtitle="Cómo van todos los negocios. Elige uno para ver el suyo." />

	<div class="flex flex-col gap-6">
		<ReportOverview scope="platform" />
	</div>
</Page>
