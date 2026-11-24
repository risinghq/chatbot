<script lang="ts">
import { BUSINESS_KINDS, type BusinessKind } from "@vendeya/types";
import { goto } from "$app/navigation";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Button from "#lib/components/ui/button.svelte";
import { BUSINESS_KIND_PROFILES } from "#lib/catalog/business-kinds.js";
import { auth } from "#lib/state/auth.svelte.js";
import { businessPath } from "#lib/state/business.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";

let step = $state<"kind" | "tour">("kind");
let saving = $state<BusinessKind | null>(null);

// "Otro" is the way out, so it sits apart from the kinds a shop recognises.
const kinds = BUSINESS_KINDS.filter((k) => k !== "other");

async function choose(kind: BusinessKind) {
  saving = kind;
  try {
    await fetchApi("/api/admin/business", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_kind: kind }),
    });
    await auth.loadTenants();
    step = "tour";
  } catch {
    toast.error("No se pudo guardar. Intenta de nuevo.");
  } finally {
    saving = null;
  }
}

const tour = [
  {
    title: "Tu cliente escribe por WhatsApp",
    body: "El asistente responde con tu catálogo: precios, fotos, variantes y stock.",
  },
  {
    title: "El asistente toma el pedido",
    body: "Pide los datos de entrega, separa el stock y ofrece tus métodos de pago.",
  },
  {
    title: "Tú decides cuando hace falta",
    body: "Si el cliente pide una persona o algo se sale de lo normal, la conversación te espera en Conversaciones.",
  },
  {
    title: "Confirmas el pago y envías",
    body: "En Pedidos marcas el pago, el empaque y la entrega. El historial guarda quién hizo qué.",
  },
];
</script>

<PageTitle title="Bienvenida" />

<Page>
	<div class="mx-auto flex w-full max-w-2xl flex-col gap-6 py-6">
		{#if step === "kind"}
			<div class="flex flex-col gap-1">
				<p class="text-sm text-fg-muted">Paso 1 de 2</p>
				<h1 class="text-xl font-semibold text-fg">¿Qué vendes?</h1>
				<p class="text-fg-muted">
					Así adaptamos el catálogo a tu negocio: tallas y colores para ropa,
					presentaciones para comida, modelos para electrónica. Puedes cambiarlo
					después en Ajustes.
				</p>
			</div>

			<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{#each kinds as kind (kind)}
					{@const profile = BUSINESS_KIND_PROFILES[kind]}
					<button
						type="button"
						class="flex flex-col items-start gap-0.5 rounded-md border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
						disabled={saving !== null}
						onclick={() => choose(kind)}
					>
						<span class="font-medium text-fg">{profile.label}</span>
						<span class="text-sm text-fg-muted">{profile.examples}</span>
					</button>
				{/each}
			</div>

			<div class="flex justify-end">
				<Button variant="ghost" disabled={saving !== null} onclick={() => choose("other")}>
					Vendo otra cosa
				</Button>
			</div>
		{:else}
			<div class="flex flex-col gap-1">
				<p class="text-sm text-fg-muted">Paso 2 de 2</p>
				<h1 class="text-xl font-semibold text-fg">Así funciona VendeYa</h1>
			</div>

			<ol class="flex flex-col gap-3">
				{#each tour as item, i (item.title)}
					<li class="flex gap-3 rounded-md border border-border bg-surface px-4 py-3">
						<span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-sm text-fg tabular-nums">{i + 1}</span>
						<div class="flex flex-col gap-0.5">
							<span class="font-medium text-fg">{item.title}</span>
							<span class="text-sm text-fg-muted">{item.body}</span>
						</div>
					</li>
				{/each}
			</ol>

			<p class="text-fg-muted">
				En el inicio verás una lista con los pasos para dejar listo tu negocio.
			</p>

			<div class="flex justify-end">
				<Button onclick={() => goto(businessPath())}>Empezar</Button>
			</div>
		{/if}
	</div>
</Page>
