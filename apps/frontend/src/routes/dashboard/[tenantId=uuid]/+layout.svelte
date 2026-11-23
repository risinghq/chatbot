<script lang="ts">
import { page } from "$app/state";
import AppSidebar from "#lib/components/shared/app-sidebar.svelte";
import DashboardShell from "#lib/components/shared/dashboard-shell.svelte";
import { businessPath } from "#lib/state/business.svelte.js";

let { children } = $props();
</script>

<DashboardShell home={businessPath()}>
	{#snippet sidebar()}
		<AppSidebar />
	{/snippet}
	<!-- A page holds one business's data, so another business mounts it afresh. -->
	{#key page.params.tenantId}
		{@render children()}
	{/key}
</DashboardShell>
