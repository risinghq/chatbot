<script lang="ts">
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { validateDni } from "#lib/utils/validation.js";
import type {
  LookupResult,
  ProviderLookup,
} from "#lib/utils/provider-lookup.js";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import LookupResultCard from "#lib/components/providers/lookup-result.svelte";
import { onMount } from "svelte";

let dni = $state("");
let tenantId = $state("");
let tenants = $state<{ id: string; name: string }[]>([]);
let loading = $state(false);

onMount(async () => {
  try {
    const data = await fetchApi<{
      tenants: { id: string; name: string }[];
    }>("/api/tenants");
    tenants = data.tenants;
    if (tenants.length === 1) tenantId = tenants[0]!.id;
  } catch {
    // Without a tenant the lookup still runs and reports FNB needs one.
  }
});
let result = $state<LookupResult | null>(null);
// Providers whose circuit breaker was closed for the last lookup. The lookup
// response is the only health the dashboard can reach, so the dots wait for one.
let providersChecked = $state<string[] | null>(null);
let error = $state("");

async function handleQuery() {
  const dniError = validateDni(dni);
  if (dniError) {
    error = dniError;
    return;
  }

  loading = true;
  error = "";
  result = null;

  try {
    const query = tenantId ? `?tenant=${tenantId}` : "";
    const data = await fetchApi<ProviderLookup>(
      `/api/providers/${dni}${query}`,
    );
    result = data.result;
    providersChecked = data.providersChecked;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      error = "Esta consulta está reservada al personal de VendeYa.";
    } else {
      error = err instanceof Error ? err.message : "Error de conexión";
    }
  } finally {
    loading = false;
  }
}
</script>

<PageTitle title="Proveedores" />

<Page width="narrow">
	<PageHeader title="Historial crediticio" subtitle="Consulta si un cliente califica para crédito en Cálidda.">
		{#snippet actions()}
			{#if providersChecked}
				<ul class="flex gap-4 text-sm text-fg-muted">
					{@render provider("fnb", "Sistema FNB")}
					{@render provider("gaso", "Sistema Gaso")}
				</ul>
			{/if}
		{/snippet}
	</PageHeader>

	<form
		class="mb-6 rounded-md border border-border bg-surface p-4"
		onsubmit={(e) => {
			e.preventDefault();
			handleQuery();
		}}
	>
		<FormField label="Negocio (cuenta de Cálidda)" for="tenant">
			<Select
				id="tenant"
				bind:value={tenantId}
				placeholder="Sin negocio: FNB no consulta"
				items={tenants.map((t) => ({ value: t.id, label: t.name }))}
			/>
		</FormField>
		<FormField label="DNI del cliente" for="dni" error={error || undefined} class="mb-0!">
			<div class="flex gap-2">
				<Input id="dni" bind:value={dni} disabled={loading} placeholder="12345678" class="font-mono tabular-nums" />
				<Button type="submit" disabled={loading || !dni}>
					{loading ? "Consultando…" : "Consultar"}
				</Button>
			</div>
		</FormField>
	</form>

	{#if result}
		<LookupResultCard {result} />
	{/if}
</Page>

{#snippet provider(key: string, label: string)}
	{@const up = providersChecked?.includes(key)}
	<li class="flex items-center gap-1.5">
		<span aria-hidden="true" class="size-2 rounded-full {up ? 'bg-success' : 'bg-danger'}"></span>
		{label}<span class="sr-only">: {up ? "responde" : "sin respuesta"}</span>
	</li>
{/snippet}
