<script lang="ts">
import { auth } from "#lib/state/auth.svelte.js";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
</script>

<div class="rounded-md border border-border bg-surface">
	<EmptyState
		title="No hay un negocio seleccionado"
		description="Esta página trabaja dentro de un negocio. Elige uno para continuar."
	>
		{#snippet action()}
			{#if auth.isPlatformOperator}
				<Button href="/dashboard/negocios">Ir a Negocios</Button>
			{/if}
		{/snippet}
	</EmptyState>
</div>
