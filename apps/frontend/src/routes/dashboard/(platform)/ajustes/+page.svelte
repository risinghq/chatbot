<script lang="ts">
import { onMount } from "svelte";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

// The platform table also holds deployment settings this page does not show,
// so a save posts only these keys.
const KEYS = [
  "powerbi_resource_key",
  "powerbi_report_id",
  "powerbi_dataset_id",
  "powerbi_model_id",
  "force_fnb_down",
  "force_gaso_down",
] as const;
type Key = (typeof KEYS)[number];
type Values = Record<Key, string>;

function pick(data: Record<string, string>): Values {
  return Object.fromEntries(
    KEYS.map((key) => [key, data[key] ?? ""]),
  ) as Values;
}

let settings = $state<Values>(pick({}));
let initial = $state<Values>(pick({}));
let loading = $state(true);
let failed = $state(false);
let saving = $state(false);

const hasChanges = $derived(
  JSON.stringify(settings) !== JSON.stringify(initial),
);

onMount(async () => {
  try {
    const data = await fetchApi<Record<string, string>>(
      "/api/platform/settings",
    );
    settings = pick(data);
    initial = pick(data);
  } catch {
    failed = true;
  } finally {
    loading = false;
  }
});

async function save() {
  saving = true;
  try {
    await fetchApi("/api/platform/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    initial = { ...settings };
    toast.success("Configuración guardada");
  } catch (e) {
    toast.error(
      e instanceof ApiError ? e.message : "Error al guardar la configuración",
    );
  } finally {
    saving = false;
  }
}
</script>

<PageTitle title="Ajustes de la plataforma" />

<Page width="narrow">
	<PageHeader title="Ajustes de la plataforma" subtitle="Valores que comparten todos los negocios." />

	{#if loading}
		<div class="flex flex-col gap-3" aria-busy="true">
			<div class="h-32 animate-pulse rounded-md bg-sunken"></div>
			<div class="h-32 animate-pulse rounded-md bg-sunken"></div>
		</div>
	{:else if failed}
		<p class="text-base text-fg-muted">No se pudo cargar la configuración.</p>
	{:else}
		<form
			class="flex flex-col gap-6"
			onsubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<SectionShell
				title="Reporte Power BI (GASO)"
				description="El reporte público de Cálidda que consulta la verificación GASO."
			>
				<div class="grid gap-x-4 p-4 md:grid-cols-2">
					<FormField label="Resource key" for="powerbi-resource-key">
						<Input id="powerbi-resource-key" bind:value={settings.powerbi_resource_key} class="font-mono" />
					</FormField>
					<FormField label="Report id" for="powerbi-report-id">
						<Input id="powerbi-report-id" bind:value={settings.powerbi_report_id} class="font-mono" />
					</FormField>
					<FormField label="Dataset id" for="powerbi-dataset-id" class="md:mb-0!">
						<Input id="powerbi-dataset-id" bind:value={settings.powerbi_dataset_id} class="font-mono" />
					</FormField>
					<FormField label="Model id" for="powerbi-model-id" class="mb-0!">
						<Input id="powerbi-model-id" bind:value={settings.powerbi_model_id} class="font-mono" />
					</FormField>
				</div>
			</SectionShell>

			<SectionShell
				title="Proveedores de crédito"
				description="Suspende un proveedor para todos los negocios cuando falla. El bot usa la otra verificación si puede."
			>
				<div class="divide-y divide-border-subtle">
					{@render providerSwitch(
						"force_fnb_down",
						"Suspender FNB (Cálidda)",
						"La verificación de elegibilidad deja de consultar a Cálidda.",
					)}
					{@render providerSwitch(
						"force_gaso_down",
						"Suspender GASO (Power BI)",
						"La verificación deja de consultar el reporte de Power BI.",
					)}
				</div>
			</SectionShell>

			{#if hasChanges}
				<div
					class="sticky bottom-4 flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3 shadow-md"
				>
					<p class="text-sm text-fg-muted">Tienes cambios sin guardar.</p>
					<div class="flex gap-2">
						<Button variant="ghost" onclick={() => (settings = { ...initial })}>Descartar</Button>
						<Button type="submit" disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Button>
					</div>
				</div>
			{/if}
		</form>
	{/if}
</Page>

{#snippet providerSwitch(key: "force_fnb_down" | "force_gaso_down", label: string, description: string)}
	<label class="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-hover">
		<input
			type="checkbox"
			checked={settings[key] === "true"}
			onchange={(e) => (settings[key] = e.currentTarget.checked ? "true" : "false")}
			class="mt-1 size-4 rounded-sm border-border bg-surface text-accent"
		/>
		<span class="min-w-0">
			<span class="block text-base text-fg">{label}</span>
			<span class="block text-sm text-fg-muted">{description}</span>
		</span>
	</label>
{/snippet}
