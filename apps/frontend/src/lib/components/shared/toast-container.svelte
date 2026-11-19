<script lang="ts">
import { toast } from "#lib/state/toast.svelte.js";
import Toast from "./toast.svelte";
</script>

<div class="pointer-events-none fixed right-4 bottom-4 left-4 z-100 flex flex-col items-center gap-2 md:left-auto md:items-end">
	{#each toast.items as item (item.id)}
		<div class="pointer-events-auto">
			<Toast
				id={item.id}
				message={item.message}
				type={item.type}
				onDismiss={toast.remove}
			/>
		</div>
	{/each}
</div>
