<script lang="ts">
import {
  ASSISTANT_TEXT_LIMIT,
  type AssistantModel,
  type AssistantSettings,
  type StockLocation,
} from "@vendeya/types";
import { fetchApi } from "#lib/utils/api.js";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { formatDateTime } from "#lib/utils/formatters.js";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import Select from "#lib/components/ui/select.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import AssistantTabs from "#lib/components/assistant/assistant-tabs.svelte";
import NeedsTenant from "#lib/components/shared/needs-tenant.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

let { data } = $props();

const MODEL_ITEMS: { value: AssistantModel; label: string }[] = [
  { value: "gpt-5-mini", label: "Equilibrado (recomendado)" },
  { value: "gpt-5", label: "Más capaz: más lento y más caro" },
  { value: "gpt-5-nano", label: "Más rápido y barato: para preguntas simples" },
];

const TEXTS = [
  {
    key: "instructions",
    title: "Indicaciones",
    description:
      "Cómo atiende el asistente: el trato, el tono y lo que debe priorizar o evitar.",
    placeholder:
      "Trata al cliente de usted. Si pregunta por tallas, ofrece la guía de medidas.",
  },
  {
    key: "faq",
    title: "Preguntas frecuentes",
    description:
      "Lo que los clientes preguntan y no está en el catálogo: horarios, tiendas, garantías.",
    placeholder:
      "¿Tienen tienda física? Sí, en Av. Larco 123, de lunes a sábado de 10 a 20 h.",
  },
  {
    key: "policies",
    title: "Políticas",
    description:
      "Cambios, devoluciones, plazos de entrega y lo que el asistente no puede prometer.",
    placeholder:
      "Cambios dentro de los 7 días con la boleta y la prenda sin uso.",
  },
] as const;

let settings = $state<AssistantSettings | null>(null);
let draft = $state<Omit<AssistantSettings, "updated_at"> | null>(null);
let locations = $state<StockLocation[]>([]);
let saving = $state(false);

let canEdit = $derived(auth.canEditCatalog);
let locationItems = $derived([
  { value: "", label: "Sin elegir" },
  ...locations.map((l) => ({ value: l.id, label: l.name })),
]);
let changed = $derived(
  settings !== null &&
    draft !== null &&
    (Object.keys(draft) as (keyof typeof draft)[]).some(
      (k) => draft![k] !== settings![k],
    ),
);

function edit(next: AssistantSettings) {
  settings = next;
  const { updated_at: _, ...fields } = next;
  draft = { ...fields };
}

async function load() {
  try {
    const [loaded, locs] = await Promise.all([
      fetchApi<AssistantSettings>("/api/assistant/settings"),
      fetchApi<StockLocation[]>("/api/stock/locations"),
    ]);
    locations = locs;
    edit(loaded);
  } catch (e) {
    toast.error(
      e instanceof Error ? e.message : "No se pudo cargar el asistente",
    );
  }
}

$effect(() => {
  if (data.user?.activeTenantId) load();
});

async function save() {
  if (!draft) return;
  saving = true;
  try {
    const saved = await fetchApi<AssistantSettings>("/api/assistant/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...draft,
        stock_location_id: draft.stock_location_id || null,
      }),
    });
    edit(saved);
    toast.success("Asistente guardado");
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "No se pudo guardar");
  } finally {
    saving = false;
  }
}
</script>

<PageTitle title="Asistente" />

<Page width="narrow">
	{#if !data.user?.activeTenantId}
		<PageHeader title="Asistente" />
		<NeedsTenant />
	{:else}
		<PageHeader
			title="Asistente"
			subtitle="Lo que el asistente sabe del negocio, además del catálogo, el stock, las zonas de envío y los métodos de pago."
		>
			{#snippet actions()}
				{#if canEdit}
					<Button size="sm" onclick={save} disabled={!changed || saving}>
						{saving ? "Guardando…" : "Guardar"}
					</Button>
				{/if}
			{/snippet}
		</PageHeader>

		<AssistantTabs class="-mx-4 mb-6 border-b border-border-subtle px-4 md:mx-0 md:px-0" />

		{#if draft}
			<div class="flex flex-col gap-6">
				{#each TEXTS as text (text.key)}
					<SectionShell title={text.title} description={text.description}>
						<div class="p-4">
							<Textarea
								id="assistant-{text.key}"
								bind:value={draft[text.key]}
								rows={6}
								placeholder={text.placeholder}
								disabled={!canEdit}
								error={draft[text.key].length > ASSISTANT_TEXT_LIMIT}
							/>
							<p class="mt-1.5 text-right text-xs text-fg-muted tabular-nums">
								{draft[text.key].length} / {ASSISTANT_TEXT_LIMIT}
							</p>
						</div>
					</SectionShell>
				{/each}

				<SectionShell title="Funcionamiento" description="El modelo que responde y de qué ubicación vende.">
					<div class="grid gap-x-4 p-4 sm:grid-cols-2">
						<FormField label="Modelo" for="assistant-model">
							<Select id="assistant-model" bind:value={draft.model} items={MODEL_ITEMS} disabled={!canEdit} />
						</FormField>
						{#if locations.length > 1}
							<FormField label="Vende desde" for="assistant-location">
								<Select
									id="assistant-location"
									bind:value={() => draft!.stock_location_id ?? "", (v) => (draft!.stock_location_id = v || null)}
									items={locationItems}
									disabled={!canEdit}
								/>
								{#if !draft.stock_location_id}
									<p class="mt-1.5 text-sm text-warning-text">
										Con varias ubicaciones y ninguna elegida, el asistente no toma pedidos: los pasa al equipo.
									</p>
								{/if}
							</FormField>
						{/if}
					</div>
				</SectionShell>

				{#if settings?.updated_at}
					<p class="text-sm text-fg-muted">Guardado el {formatDateTime(settings.updated_at)}</p>
				{/if}
			</div>
		{/if}
	{/if}
</Page>
