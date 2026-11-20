<script lang="ts">
import type { CustomerAddress } from "@vendeya/types";
import { invalidateAll } from "$app/navigation";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import Input from "#lib/components/ui/input.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";

type Props = {
  customerId: string;
  addresses: CustomerAddress[];
  canEdit: boolean;
};

let { customerId, addresses, canEdit }: Props = $props();

const emptyForm = { line: "", district: "", city: "", reference: "" };
let open = $state(false);
let form = $state({ ...emptyForm });
let lineError = $state<string | undefined>();
let isSaving = $state(false);

function openAdd() {
  form = { ...emptyForm };
  lineError = undefined;
  open = true;
}

async function add() {
  lineError = form.line.trim() ? undefined : "Escribe la dirección";
  if (lineError) return;
  isSaving = true;
  try {
    await fetchApi(`/api/customers/${customerId}/addresses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        line: form.line.trim(),
        district: form.district.trim() || null,
        city: form.city.trim() || null,
        reference: form.reference.trim() || null,
      }),
    });
    await invalidateAll();
    toast.success("Dirección agregada");
    open = false;
  } catch {
    toast.error("No se pudo guardar la dirección");
  } finally {
    isSaving = false;
  }
}

async function remove(address: CustomerAddress) {
  if (!confirm(`¿Eliminar ${address.line}? Los envíos ya hechos la conservan.`))
    return;
  try {
    await fetchApi(`/api/customers/${customerId}/addresses/${address.id}`, {
      method: "DELETE",
    });
    await invalidateAll();
    toast.success("Dirección eliminada");
  } catch {
    toast.error("No se pudo eliminar la dirección");
  }
}

function place(address: CustomerAddress) {
  return [address.district, address.city].filter(Boolean).join(", ");
}
</script>

<SectionShell title="Direcciones" description="Dónde se le entrega. Un envío copia la dirección, así que cambiarla no altera pedidos anteriores.">
	{#snippet action()}
		{#if canEdit}
			<Button size="sm" variant="secondary" onclick={openAdd}>Agregar dirección</Button>
		{/if}
	{/snippet}

	{#if addresses.length > 0}
		<ul class="divide-y divide-border-subtle">
			{#each addresses as address (address.id)}
				<li class="flex items-start justify-between gap-3 px-4 py-3">
					<div class="min-w-0">
						<p class="text-fg">{address.line}</p>
						{#if place(address)}
							<p class="text-sm text-fg-muted">{place(address)}</p>
						{/if}
						{#if address.reference}
							<p class="text-sm text-fg-muted">Ref. {address.reference}</p>
						{/if}
					</div>
					{#if canEdit}
						<Button size="sm" variant="ghost" onclick={() => remove(address)} aria-label="Eliminar dirección">
							<Icon name="trash" class="size-4" />
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="px-4 py-3 text-sm text-fg-muted">Sin direcciones guardadas.</p>
	{/if}
</SectionShell>

<Modal bind:open title="Nueva dirección" onClose={() => (open = false)}>
	<FormField label="Dirección*" for="address-line" error={lineError}>
		<Input id="address-line" bind:value={form.line} placeholder="Ej. Av. Arequipa 1234, dpto. 502" />
	</FormField>
	<div class="grid grid-cols-2 gap-x-4">
		<FormField label="Distrito" for="address-district">
			<Input id="address-district" bind:value={form.district} placeholder="Ej. Miraflores" />
		</FormField>
		<FormField label="Ciudad" for="address-city">
			<Input id="address-city" bind:value={form.city} placeholder="Ej. Lima" />
		</FormField>
	</div>
	<FormField label="Referencia" for="address-reference">
		<Input id="address-reference" bind:value={form.reference} placeholder="Ej. Frente al parque" />
	</FormField>

	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)} disabled={isSaving}>Cancelar</Button>
		<Button onclick={add} disabled={isSaving}>{isSaving ? "Guardando…" : "Agregar"}</Button>
	{/snippet}
</Modal>
