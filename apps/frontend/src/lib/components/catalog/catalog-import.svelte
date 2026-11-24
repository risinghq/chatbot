<script lang="ts">
import type { StockLocation } from "@vendeya/types";
import { invalidateAll } from "$app/navigation";
import { businessKindProfile } from "#lib/catalog/business-kinds.js";
import { importTemplate } from "#lib/catalog/import-template.js";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { formatCents } from "#lib/utils/money.js";
import Badge from "#lib/components/ui/badge.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import Button from "#lib/components/ui/button.svelte";
import FileUpload from "#lib/components/ui/file-upload.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import Select from "#lib/components/ui/select.svelte";

type Summary = {
  new_products: number;
  new_variants: number;
  updated_variants: number;
  units: number;
};

type Preview = {
  summary: Summary;
  errors: { row: number; message: string }[];
  ignored_columns: string[];
  rows: {
    row: number;
    product: string;
    variant: string | null;
    sku: string | null;
    price_cents: number;
    stock: number;
    action: "create" | "update";
  }[];
  locations: StockLocation[];
};

/** The preview lists this many rows; the summary counts them all. */
const SHOWN_ROWS = 100;

let { open = $bindable(false) }: { open: boolean } = $props();

let file = $state<File | null>(null);
let preview = $state<Preview | null>(null);
let refusal = $state<string | null>(null);
let locationId = $state<string | undefined>(undefined);
let busy = $state(false);

const canImport = $derived(
  preview !== null &&
    preview.errors.length === 0 &&
    preview.rows.length > 0 &&
    (preview.locations.length === 0 || locationId !== undefined),
);

function reset() {
  file = null;
  preview = null;
  refusal = null;
  locationId = undefined;
}

function close() {
  open = false;
  reset();
}

function downloadTemplate() {
  const profile = businessKindProfile(auth.openTenant?.business_kind);
  const blob = new Blob([importTemplate(profile)], {
    type: "text/csv;charset=utf-8",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "plantilla-productos.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function upload(path: string): Promise<unknown> {
  const form = new FormData();
  form.set("file", file!);
  if (locationId) form.set("location_id", locationId);
  return fetchApi(`/api/catalog/import${path}`, { method: "POST", body: form });
}

async function check(selected: File | null) {
  preview = null;
  refusal = null;
  locationId = undefined;
  if (!selected) return;
  busy = true;
  try {
    preview = (await upload("/preview")) as Preview;
  } catch (error) {
    refusal =
      error instanceof ApiError ? error.message : "No se pudo leer el archivo";
  } finally {
    busy = false;
  }
}

async function confirmImport() {
  if (!preview) return;
  busy = true;
  try {
    const summary = (await upload("")) as Summary;
    await invalidateAll();
    toast.success(
      `Listo: ${plural(summary.new_variants, "variante nueva", "variantes nuevas")} y ${plural(summary.updated_variants, "actualizada", "actualizadas")}`,
    );
    close();
  } catch (error) {
    toast.error(
      error instanceof ApiError ? error.message : "No se pudo importar",
    );
  } finally {
    busy = false;
  }
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}
</script>

<Modal
  bind:open
  title="Importar productos"
  subtitle="Sube una hoja de Excel o CSV con una fila por variante"
  onClose={close}
>
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-2 text-sm text-fg-muted sm:flex-row sm:items-center sm:justify-between">
      <p>
        La primera fila nombra las columnas: al menos <strong class="text-fg">Producto</strong> y
        <strong class="text-fg">Precio</strong>. Un SKU que ya existe actualiza su precio.
      </p>
      <Button size="sm" variant="secondary" onclick={downloadTemplate}>Descargar plantilla</Button>
    </div>

    <FileUpload
      accept=".xlsx,.xls,.csv"
      bind:file
      placeholder="Elige o arrastra el archivo .xlsx o .csv"
      onchange={check}
    />

    {#if busy && !preview}
      <p class="text-sm text-fg-muted" role="status">Revisando el archivo…</p>
    {/if}

    {#if refusal}
      <Banner tone="danger" title="No se pudo leer el archivo">{refusal}</Banner>
    {/if}

    {#if preview}
      {@const s = preview.summary}
      {#if preview.errors.length > 0}
        <Banner tone="danger" title="Corrige estas filas y vuelve a subir el archivo">
          <ul class="mt-1 list-disc pl-5">
            {#each preview.errors as error (error.row + error.message)}
              <li>Fila {error.row}: {error.message}</li>
            {/each}
          </ul>
        </Banner>
      {:else if preview.rows.length === 0}
        <Banner tone="warning">El archivo no tiene filas con productos.</Banner>
      {:else}
        <Banner tone="success">
          <ul>
            {#if s.new_variants > 0}
              <li>
                Nuevos: {plural(s.new_products, "producto", "productos")} y
                {plural(s.new_variants, "variante", "variantes")}
              </li>
            {/if}
            {#if s.updated_variants > 0}
              <li>Cambian precio: {plural(s.updated_variants, "variante", "variantes")}</li>
            {/if}
            {#if s.units > 0}
              <li>Entran al stock: {plural(s.units, "unidad", "unidades")}</li>
            {/if}
          </ul>
        </Banner>
      {/if}

      {#if preview.ignored_columns.length > 0}
        <p class="text-sm text-fg-muted">
          Columnas que no se usan: {preview.ignored_columns.join(", ")}
        </p>
      {/if}

      {#if preview.locations.length > 0}
        <FormField label="Almacén que recibe el stock" for="import-location">
          <Select
            id="import-location"
            bind:value={locationId}
            placeholder="Elige un almacén"
            items={preview.locations.map((l) => ({ value: l.id, label: l.name }))}
          />
        </FormField>
      {/if}

      {#if preview.rows.length > 0}
        <div class="overflow-x-auto rounded-md border border-border-subtle">
          <table class="w-full text-sm">
            <thead class="bg-sunken text-left text-fg-muted">
              <tr>
                <th class="px-2 py-1.5 font-medium">Fila</th>
                <th class="px-2 py-1.5 font-medium">Producto</th>
                <th class="px-2 py-1.5 font-medium">Variante</th>
                <th class="px-2 py-1.5 font-medium">SKU</th>
                <th class="px-2 py-1.5 text-right font-medium">Precio</th>
                <th class="px-2 py-1.5 text-right font-medium">Stock</th>
                <th class="px-2 py-1.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {#each preview.rows.slice(0, SHOWN_ROWS) as row (row.row)}
                <tr class="border-t border-border-subtle">
                  <td class="px-2 py-1.5 text-fg-muted tabular-nums">{row.row}</td>
                  <td class="px-2 py-1.5">{row.product}</td>
                  <td class="px-2 py-1.5">{row.variant ?? "–"}</td>
                  <td class="px-2 py-1.5 text-fg-muted">{row.sku ?? (row.action === "create" ? "Automático" : "–")}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums">{formatCents(row.price_cents)}</td>
                  <td class="px-2 py-1.5 text-right tabular-nums">
                    {row.action === "create" ? row.stock : "–"}
                  </td>
                  <td class="px-2 py-1.5">
                    {#if row.action === "create"}
                      <Badge variant="success">Nueva</Badge>
                    {:else}
                      <Badge variant="info">Actualiza</Badge>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if preview.rows.length > SHOWN_ROWS}
          <p class="text-sm text-fg-muted">
            Y {preview.rows.length - SHOWN_ROWS} filas más.
          </p>
        {/if}
        {#if s.updated_variants > 0}
          <p class="text-sm text-fg-muted">
            El stock de una variante que ya existe no cambia; muévelo en Inventario.
          </p>
        {/if}
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>Cancelar</Button>
    <Button disabled={!canImport || busy} onclick={confirmImport}>
      {busy && preview ? "Importando…" : "Importar"}
    </Button>
  {/snippet}
</Modal>
