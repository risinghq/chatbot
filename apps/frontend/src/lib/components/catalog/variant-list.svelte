<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import type { ProductVariant, StockRow } from "@vendeya/types";
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
import {
  type BusinessKindProfile,
  splitValues,
  variantNames,
} from "#lib/catalog/business-kinds.js";

type Props = {
  productId: string;
  variants: ProductVariant[];
  /** The product's stock rows, summed over every location. */
  stock: StockRow[];
  canEdit: boolean;
  /** What the business sells, which names the options it usually offers. */
  kind: BusinessKindProfile;
  /** Called with the full list after each save, for the photos' variant tags. */
  onChange?: (variants: ProductVariant[]) => void;
};

let {
  productId,
  variants: initial,
  stock,
  canEdit,
  kind,
  onChange,
}: Props = $props();

let available = $derived(
  new Map(stock.map((row) => [row.variant_id, row.available])),
);

let saved = $state<ProductVariant[] | null>(null);
let variants = $derived(saved ?? initial);

function keep(list: ProductVariant[]) {
  saved = list;
  onChange?.(list);
}

let open = $state(false);
let editing = $state<ProductVariant | null>(null);
let form = $state({ name: "", sku: "", price: "", cost: "", active: true });
let errors = $state<Record<string, string>>({});
let isSaving = $state(false);

function openFor(variant: ProductVariant | null) {
  editing = variant;
  form = variant
    ? {
        name: variant.name ?? "",
        sku: variant.sku,
        price: (variant.price_cents / 100).toFixed(2),
        cost:
          variant.cost_cents === null
            ? ""
            : (variant.cost_cents / 100).toFixed(2),
        active: variant.is_active === 1,
      }
    : { name: "", sku: "", price: "", cost: "", active: true };
  errors = {};
  open = true;
}

function formProblems(
  price: number | null,
  cost: number | null,
): Record<string, string> {
  const problems: Record<string, string> = {};
  if (editing && !form.sku.trim())
    problems.sku = "El SKU no puede quedar vacío";
  if (price === null) problems.price = "Escribe un monto, por ejemplo 49.90";
  if (form.cost.trim() !== "" && cost === null)
    problems.cost = "Escribe un monto, por ejemplo 21.00";
  return problems;
}

async function save() {
  const price = parseCents(form.price);
  const cost = form.cost.trim() === "" ? null : parseCents(form.cost);
  errors = formProblems(price, cost);
  if (Object.keys(errors).length > 0) return;

  const body = JSON.stringify({
    name: form.name.trim() || null,
    sku: form.sku.trim() || undefined,
    price_cents: price,
    cost_cents: cost,
    is_active: form.active,
  });

  isSaving = true;
  try {
    const variant = await fetchApi<ProductVariant>(
      editing
        ? `/api/catalog/variants/${editing.id}`
        : `/api/catalog/products/${productId}/variants`,
      {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
    );
    keep(
      editing
        ? variants.map((v) => (v.id === variant.id ? variant : v))
        : [...variants, variant],
    );
    toast.success(editing ? "Variante actualizada" : "Variante agregada");
    open = false;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      errors = { sku: "Otra variante ya usa este SKU" };
    else
      toast.error(
        error instanceof Error
          ? error.message
          : "No se pudo guardar la variante",
      );
  } finally {
    isSaving = false;
  }
}

/** The most variants one grid creates, so a typo cannot flood the catalog. */
const GRID_LIMIT = 50;

let gridOpen = $state(false);
let grid = $state({
  axes: [] as { name: string; text: string }[],
  price: "",
  cost: "",
});
let gridErrors = $state<Record<string, string>>({});
let gridProgress = $state<number | null>(null);

let taken = $derived(
  new Set(variants.map((v) => (v.name ?? "").trim().toLowerCase())),
);
let gridNames = $derived(
  variantNames(
    grid.axes.map((axis) => ({
      name: axis.name,
      values: splitValues(axis.text),
    })),
  ),
);
let gridNew = $derived(gridNames.filter((n) => !taken.has(n.toLowerCase())));
let repeated = $derived(gridNames.length - gridNew.length);

function openGrid() {
  const axes = kind.axes.map((axis) => ({
    name: axis.name,
    text: axis.values.join(", "),
  }));
  // A second axis is always offered, since a size often comes in colours too.
  if (axes.length < 2) axes.push({ name: "", text: "" });
  grid = { axes, price: "", cost: "" };
  gridErrors = {};
  gridOpen = true;
}

async function createGrid() {
  const price = parseCents(grid.price);
  const cost = grid.cost.trim() === "" ? null : parseCents(grid.cost);
  const problems: Record<string, string> = {};
  if (price === null) problems.price = "Escribe un monto, por ejemplo 49.90";
  if (grid.cost.trim() !== "" && cost === null)
    problems.cost = "Escribe un monto, por ejemplo 21.00";
  if (gridNew.length === 0)
    problems.values = "Escribe al menos una opción nueva";
  if (gridNew.length > GRID_LIMIT)
    problems.values = `Son ${gridNew.length} variantes; el máximo es ${GRID_LIMIT} a la vez`;
  gridErrors = problems;
  if (Object.keys(problems).length > 0) return;

  // One at a time, so a failure leaves a clear count of what was made.
  const made: ProductVariant[] = [];
  gridProgress = 0;
  try {
    for (const name of gridNew) {
      made.push(
        await fetchApi<ProductVariant>(
          `/api/catalog/products/${productId}/variants`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name,
              price_cents: price,
              cost_cents: cost,
            }),
          },
        ),
      );
      gridProgress = made.length;
    }
    toast.success(`${made.length} variantes agregadas`);
    gridOpen = false;
  } catch (error) {
    toast.error(
      `Se agregaron ${made.length} de ${gridNew.length}. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  } finally {
    keep([...variants, ...made]);
    gridProgress = null;
  }
}

const columns = [
  { header: "Variante", cell: nameCell },
  {
    header: "SKU",
    key: "sku" as const,
    class: "font-mono text-sm whitespace-nowrap",
  },
  { header: "Precio", cell: priceCell, align: "right" as const },
  { header: "Costo", cell: costCell, align: "right" as const },
  { header: "Disponible", cell: stockCell, align: "right" as const },
];
</script>

<SectionShell
  title="Variantes"
  description="Cada variante tiene su SKU, precio y stock. Un producto de una sola forma lleva una variante sin nombre. El stock se registra en Inventario."
>
  {#snippet action()}
    {#if canEdit}
      <div class="flex gap-2">
        <Button size="sm" variant="secondary" onclick={openGrid}>Agregar varias</Button>
        <Button size="sm" variant="secondary" onclick={() => openFor(null)}>
          Agregar variante
        </Button>
      </div>
    {/if}
  {/snippet}

  {#if kind.variantHint}
    <p class="border-b border-border-subtle px-4 py-3 text-sm text-fg-muted">{kind.variantHint}</p>
  {/if}

  {#if variants.length > 0}
    <DataTable
      data={variants}
      {columns}
      keyField="id"
      onRowClick={canEdit ? openFor : undefined}
    />
  {:else}
    <p class="px-4 py-3 text-sm text-fg-muted">
      Agrega una variante para poder registrar stock y vender este producto.
    </p>
  {/if}
</SectionShell>

<Modal
  bind:open
  title={editing ? "Editar variante" : "Nueva variante"}
  onClose={() => (open = false)}
>
  <FormField label="Nombre" for="variant-name">
    <Input id="variant-name" bind:value={form.name} placeholder="Ej. {kind.variantExample}" />
    <p class="mt-1.5 text-sm text-fg-muted">
      La opción que elige el cliente. Déjalo vacío si el producto tiene una sola forma.
    </p>
  </FormField>
  <FormField label={editing ? "SKU*" : "SKU"} for="variant-sku" error={errors.sku}>
    <Input id="variant-sku" bind:value={form.sku} placeholder="Ej. POLO-ROJO-M" class="font-mono" />
    {#if !editing}
      <p class="mt-1.5 text-sm text-fg-muted">Tu código interno. Si no usas códigos, déjalo vacío y se crea uno.</p>
    {/if}
  </FormField>
  <div class="grid grid-cols-2 gap-x-4">
    <FormField label="Precio*" for="variant-price" error={errors.price}>
      <Input id="variant-price" bind:value={form.price} inputmode="decimal" placeholder="49.90" />
    </FormField>
    <FormField label="Costo" for="variant-cost" error={errors.cost}>
      <Input id="variant-cost" bind:value={form.cost} inputmode="decimal" placeholder="21.00" />
    </FormField>
  </div>
  {#if editing}
    <label class="flex items-center gap-2 text-base text-fg">
      <input type="checkbox" bind:checked={form.active} />
      Se vende
    </label>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (open = false)} disabled={isSaving}>Cancelar</Button>
    <Button onclick={save} disabled={isSaving}>{isSaving ? "Guardando…" : "Guardar"}</Button>
  {/snippet}
</Modal>

<Modal bind:open={gridOpen} title="Agregar varias variantes" onClose={() => (gridOpen = false)}>
  <p class="text-sm text-fg-muted">
    Escribe las opciones separadas por comas. Se crea una variante por cada
    combinación, todas con el mismo precio; luego puedes cambiar cada una.
  </p>
  {#each grid.axes as axis, i (i)}
    <div class="grid grid-cols-[1fr_2fr] gap-x-4">
      <FormField label="Opción {i + 1}" for="grid-axis-{i}">
        <Input id="grid-axis-{i}" bind:value={axis.name} placeholder={i === 0 ? "Ej. Talla" : "Ej. Color"} />
      </FormField>
      <FormField label="Valores" for="grid-values-{i}" error={i === 0 ? gridErrors.values : undefined}>
        <Input id="grid-values-{i}" bind:value={axis.text} placeholder={i === 0 ? "S, M, L" : "Rojo, Negro"} />
      </FormField>
    </div>
  {/each}
  <div class="grid grid-cols-2 gap-x-4">
    <FormField label="Precio*" for="grid-price" error={gridErrors.price}>
      <Input id="grid-price" bind:value={grid.price} inputmode="decimal" placeholder="49.90" />
    </FormField>
    <FormField label="Costo" for="grid-cost" error={gridErrors.cost}>
      <Input id="grid-cost" bind:value={grid.cost} inputmode="decimal" placeholder="21.00" />
    </FormField>
  </div>
  {#if gridNames.length > 0}
    <div class="flex flex-col gap-1.5">
      <p class="text-sm text-fg-muted">
        {gridNew.length === 1 ? "Se creará 1 variante" : `Se crearán ${gridNew.length} variantes`}{repeated === 0
          ? ""
          : repeated === 1
            ? "; 1 ya existe"
            : `; ${repeated} ya existen`}.
      </p>
      <div class="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
        {#each gridNames as name (name)}
          <Badge class={taken.has(name.toLowerCase()) ? "line-through opacity-60" : ""}>{name}</Badge>
        {/each}
      </div>
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (gridOpen = false)} disabled={gridProgress !== null}>Cancelar</Button>
    <Button onclick={createGrid} disabled={gridProgress !== null}>
      {gridProgress === null ? "Crear variantes" : `Creando ${gridProgress} de ${gridNew.length}…`}
    </Button>
  {/snippet}
</Modal>

{#snippet nameCell(v: ProductVariant)}
  <span class="text-fg">{v.name ?? "Única"}</span>
  {#if v.is_active === 0}
    <Badge class="ml-2">No se vende</Badge>
  {/if}
{/snippet}

{#snippet priceCell(v: ProductVariant)}
  <span class="tabular-nums">{formatCents(v.price_cents)}</span>
{/snippet}

{#snippet costCell(v: ProductVariant)}
  <span class="text-fg-muted tabular-nums">{formatCents(v.cost_cents)}</span>
{/snippet}

<!-- The row click edits the variant, so the link keeps its click to itself. -->
{#snippet stockCell(v: ProductVariant)}
  <a
    href="{businessPath()}/inventario?variant={encodeURIComponent(v.id)}"
    class="text-accent-text tabular-nums hover:underline"
    onclick={(e) => e.stopPropagation()}
  >
    {available.get(v.id) ?? 0}
  </a>
{/snippet}
