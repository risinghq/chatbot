<script lang="ts">
import DashboardShell from "#lib/components/shared/dashboard-shell.svelte";
import PlatformSidebar from "#lib/components/shared/platform-sidebar.svelte";

let { children } = $props();
</script>

<DashboardShell home="/dashboard/negocios">
	{#snippet sidebar()}
		<PlatformSidebar />
	{/snippet}
	{@render children()}
</DashboardShell>
