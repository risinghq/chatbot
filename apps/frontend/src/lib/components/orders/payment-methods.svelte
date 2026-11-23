<script lang="ts">
import type { PaymentMethod } from "@vendeya/types";
import { invalidateAll } from "$app/navigation";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";

let { methods }: { methods: PaymentMethod[] } = $props();

let open = $state(false);
let editing = $state<PaymentMethod | null>(null);
let form = $state({ name: "", instructions: "", active: true });
let nameError = $state<string | undefined>();
let isSaving = $state(false);

function openFor(method: PaymentMethod | null) {
  editing = method;
  form = method
    ? {
        name: method.name,
        instructions: method.instructions ?? "",
        active: method.is_active === 1,
      }
    : { name: "", instructions: "", active: true };
  nameError = undefined;
  open = true;
}

async function save() {
  nameError = form.name.trim() ? undefined : "El nombre es obligatorio";
  if (nameError) return;

  isSaving = true;
  try {
    await fetchApi<PaymentMethod>(
      editing ? `/api/payment-methods/${editing.id}` : "/api/payment-methods",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          instructions: form.instructions.trim() || null,
          is_active: form.active,
        }),
      },
    );
    await invalidateAll();
    toast.success(
      editing ? "Método de pago actualizado" : "Método de pago agregado",
    );
    open = false;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      nameError = "Ya tienes un método de pago con este nombre";
    else toast.error("No se pudo guardar el método de pago");
  } finally {
    isSaving = false;
  }
}

async function remove() {
  if (!editing) return;
  if (
    !confirm(
      `¿Eliminar ${editing.name}? Los pagos ya registrados lo conservan.`,
    )
  )
    return;
  isSaving = true;
  try {
    await fetchApi(`/api/payment-methods/${editing.id}`, { method: "DELETE" });
    await invalidateAll();
    toast.success("Método de pago eliminado");
    open = false;
  } catch {
    toast.error("No se pudo eliminar el método de pago");
  } finally {
    isSaving = false;
  }
}

const columns = [
  { header: "Método de pago", cell: nameCell },
  { header: "Indicaciones al cliente", cell: instructionsCell },
];
</script>

<SectionShell
  title="Métodos de pago"
  description="Cómo te pagan tus clientes. Las indicaciones son lo que el cliente lee para pagar."
>
  {#snippet action()}
    <Button size="sm" variant="secondary" onclick={() => openFor(null)}>Agregar método</Button>
  {/snippet}

  {#if methods.length > 0}
    <DataTable data={methods} {columns} keyField="id" onRowClick={openFor} />
  {:else}
    <p class="px-4 py-3 text-sm text-fg-muted">
      Agrega un método de pago, por ejemplo Yape o contra entrega, para registrar pagos.
    </p>
  {/if}
</SectionShell>

<Modal bind:open title={editing ? "Editar método de pago" : "Nuevo método de pago"} onClose={() => (open = false)}>
  <FormField label="Nombre*" for="method-name" error={nameError}>
    <Input id="method-name" bind:value={form.name} placeholder="Ej. Yape" />
  </FormField>
  <FormField label="Indicaciones" for="method-instructions">
    <Textarea id="method-instructions" bind:value={form.instructions} rows={3} placeholder="Ej. Yapea al 999 888 777 a nombre de Tienda SAC y envía la captura." />
  </FormField>
  {#if editing}
    <label class="flex items-center gap-2 text-base text-fg">
      <input type="checkbox" bind:checked={form.active} />
      Disponible para pagos nuevos
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

{#snippet nameCell(m: PaymentMethod)}
  <span class="text-fg">{m.name}</span>
  {#if m.is_active === 0}
    <Badge class="ml-2">Inactivo</Badge>
  {/if}
{/snippet}

{#snippet instructionsCell(m: PaymentMethod)}
  <span class="line-clamp-2 text-sm text-fg-muted">{m.instructions ?? "–"}</span>
{/snippet}
