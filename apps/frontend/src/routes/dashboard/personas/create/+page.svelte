<script lang="ts">
import { goto } from "$app/navigation";
import { fetchApi } from "#lib/utils/api.js";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import { fieldStyles } from "#lib/components/ui/field-styles.js";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

const segments = [
  { value: "fnb", label: "FNB" },
  { value: "gaso", label: "GASO" },
  { value: "not_eligible", label: "No elegible" },
];

let loading = $state(false);
let newPersona = $state({
  id: "",
  name: "",
  description: "",
  segment: "fnb" as "fnb" | "gaso" | "not_eligible",
  clientName: "",
  dni: "",
  creditLine: 0,
  nse: undefined as number | undefined,
});

const incomplete = $derived(
  !newPersona.id ||
    !newPersona.name ||
    !newPersona.description ||
    !newPersona.clientName ||
    !newPersona.dni,
);

async function createPersona() {
  loading = true;
  try {
    await fetchApi("/api/simulator/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newPersona),
    });
    goto("/dashboard/personas");
  } catch (error) {
    console.error("Failed to create persona:", error);
    alert("Error al crear persona");
  } finally {
    loading = false;
  }
}
</script>

<PageTitle title="Crear persona" />

<Page width="narrow">
	<PageHeader title="Nueva persona de prueba" subtitle="Un perfil de cliente para usar en el simulador." />

	<div class="rounded-md border border-border bg-surface">
		<div class="divide-y divide-border-subtle">
			<section class="p-4">
				<h2 class="mb-3 text-md font-medium text-fg">Perfil</h2>
				<FormField label="ID*" for="persona-id">
					<Input id="persona-id" bind:value={newPersona.id} placeholder="fnb_test_1" class="font-mono" />
					<p class="mt-1.5 text-sm text-fg-muted">Único, sin espacios. Usa guiones bajos.</p>
				</FormField>
				<FormField label="Nombre*" for="persona-name">
					<Input id="persona-name" bind:value={newPersona.name} placeholder="FNB - Crédito Test" />
				</FormField>
				<FormField label="Descripción*" for="persona-description">
					<Textarea
						id="persona-description"
						bind:value={newPersona.description}
						placeholder="Cliente de prueba con características específicas…"
						rows={3}
					/>
				</FormField>
				<FormField label="Segmento*" for="persona-segment" class="mb-0!">
					<Select id="persona-segment" bind:value={newPersona.segment} items={segments} />
				</FormField>
			</section>

			<section class="p-4">
				<h2 class="mb-3 text-md font-medium text-fg">Cliente</h2>
				<div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
					<FormField label="Nombre del cliente*" for="persona-client-name">
						<Input id="persona-client-name" bind:value={newPersona.clientName} placeholder="JUAN PEREZ LOPEZ" />
					</FormField>
					<FormField label="DNI*" for="persona-dni">
						<input
							id="persona-dni"
							bind:value={newPersona.dni}
							placeholder="12345678"
							maxlength="8"
							inputmode="numeric"
							class="{fieldStyles(false)} h-8 font-mono pointer-coarse:h-11"
						/>
					</FormField>
					<FormField label="Línea de crédito (S/)*" for="persona-credit" class="mb-0!">
						<input
							id="persona-credit"
							type="number"
							bind:value={newPersona.creditLine}
							placeholder="3000"
							min="0"
							step="100"
							class="{fieldStyles(false)} h-8 font-mono tabular-nums pointer-coarse:h-11"
						/>
					</FormField>
					<FormField label="NSE (opcional)" for="persona-nse" class="mt-4 mb-0! sm:mt-0">
						<input
							id="persona-nse"
							type="number"
							bind:value={newPersona.nse}
							placeholder="1, 2 o 3"
							min="1"
							max="3"
							class="{fieldStyles(false)} h-8 font-mono tabular-nums pointer-coarse:h-11"
						/>
					</FormField>
				</div>
			</section>
		</div>

		<div class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
			<Button variant="secondary" href="/dashboard/personas">Cancelar</Button>
			<Button onclick={createPersona} disabled={loading || incomplete}>
				{loading ? "Creando…" : "Crear persona"}
			</Button>
		</div>
	</div>
</Page>
