<script lang="ts">
import type { DeliveryZone } from "@vendeya/types";
import { invalidateAll } from "$app/navigation";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { formatCents, parseCents } from "#lib/utils/money.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";

let { zones }: { zones: DeliveryZone[] } = $props();

let open = $state(false);
let editing = $state<DeliveryZone | null>(null);
let form = $state({ name: "", fee: "", active: true });
let errors = $state<Record<string, string>>({});
let isSaving = $state(false);

function openFor(zone: DeliveryZone | null) {
  editing = zone;
  form = zone
    ? {
        name: zone.name,
        fee: (zone.fee_cents / 100).toFixed(2),
        active: zone.is_active === 1,
      }
    : { name: "", fee: "", active: true };
  errors = {};
  open = true;
}

async function save() {
  const fee = parseCents(form.fee);
  errors = {};
  if (!form.name.trim()) errors.name = "El nombre es obligatorio";
  if (fee === null) errors.fee = "Escribe un monto, por ejemplo 10.00";
  if (Object.keys(errors).length > 0) return;

  isSaving = true;
  try {
    await fetchApi<DeliveryZone>(
      editing ? `/api/delivery-zones/${editing.id}` : "/api/delivery-zones",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          fee_cents: fee,
          is_active: form.active,
        }),
      },
    );
    await invalidateAll();
    toast.success(editing ? "Zona actualizada" : "Zona agregada");
    open = false;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      errors = { name: "Ya tienes una zona con este nombre" };
    else toast.error("No se pudo guardar la zona");
  } finally {
    isSaving = false;
  }
}

async function remove() {
  if (!editing) return;
  if (
    !confirm(
      `¿Eliminar la zona ${editing.name}? Los envíos ya hechos la conservan.`,
    )
  )
    return;
  isSaving = true;
  try {
    await fetchApi(`/api/delivery-zones/${editing.id}`, { method: "DELETE" });
    await invalidateAll();
    toast.success("Zona eliminada");
    open = false;
  } catch {
    toast.error("No se pudo eliminar la zona");
  } finally {
    isSaving = false;
  }
}

const columns = [
  { header: "Zona", cell: nameCell },
  { header: "Costo de envío", cell: feeCell, align: "right" as const },
];
</script>

<SectionShell
  title="Zonas de entrega"
  description="Dónde entregas y cuánto cobras por el envío. Un pedido sin zona se recoge en tienda."
>
  {#snippet action()}
    <Button size="sm" variant="secondary" onclick={() => openFor(null)}>Agregar zona</Button>
  {/snippet}

  {#if zones.length > 0}
    <DataTable data={zones} {columns} keyField="id" onRowClick={openFor} />
  {:else}
    <p class="px-4 py-3 text-sm text-fg-muted">
      Agrega una zona para cobrar el envío en tus pedidos.
    </p>
  {/if}
</SectionShell>

<Modal bind:open title={editing ? "Editar zona" : "Nueva zona"} onClose={() => (open = false)}>
  <FormField label="Nombre*" for="zone-name" error={errors.name}>
    <Input id="zone-name" bind:value={form.name} placeholder="Ej. Lima centro" />
  </FormField>
  <FormField label="Costo de envío*" for="zone-fee" error={errors.fee}>
    <Input id="zone-fee" bind:value={form.fee} inputmode="decimal" placeholder="10.00" />
  </FormField>
  {#if editing}
    <label class="flex items-center gap-2 text-base text-fg">
      <input type="checkbox" bind:checked={form.active} />
      Disponible para pedidos nuevos
    </label>
  {/if}

  {#snippet footer()}
    {#if editing}
      <Button variant="danger" class="mr-auto" onclick={remove} disabled={isSaving}>Eliminar</Button>
    {/if}
    <Button variant="secondary" onclick={() => (open = false)} disabled={isSaving}>Cancelar</Button>
    <Button onclick={save} disabled={isSaving}>{isSaving ? "Guardando…" : "Guardar"}</Button>
  {/snippet}
</Modal>

{#snippet nameCell(z: DeliveryZone)}
  <span class="text-fg">{z.name}</span>
  {#if z.is_active === 0}
    <Badge class="ml-2">Inactiva</Badge>
  {/if}
{/snippet}

{#snippet feeCell(z: DeliveryZone)}
  <span class="tabular-nums">S/ {formatCents(z.fee_cents)}</span>
{/snippet}
