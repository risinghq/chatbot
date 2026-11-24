<script lang="ts">
import { page } from "$app/state";
import PageTitle from "#lib/components/shared/page-title.svelte";

const missing = $derived(page.status === 404);
</script>

<PageTitle title={missing ? "Página no encontrada" : "Algo falló"} />

<main class="flex min-h-dvh flex-col items-center justify-center gap-2 p-6 text-center">
	<h1 class="text-lg font-medium text-fg">
		{missing ? "Esta página no existe" : "Algo falló"}
	</h1>
	<p class="text-base text-pretty text-fg-muted">
		{missing
			? "Puede que el enlace esté mal escrito o que la página se haya movido."
			: "Vuelve a intentarlo en un momento."}
	</p>
	<a class="mt-2 text-base text-fg underline underline-offset-2" href="/dashboard">Ir al inicio</a>
</main>
