<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import type {
  StockLocation,
  StockMovement,
  StockMovementKind,
  StockRow,
} from "@vendeya/types";
import { page } from "$app/state";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { formatCents } from "#lib/utils/money.js";
import { formatDateTime } from "#lib/utils/formatters.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import Select from "#lib/components/ui/select.svelte";
import NeedsTenant from "#lib/components/shared/needs-tenant.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

let { data } = $props();

const KIND_LABELS: Record<StockMovementKind, string> = {
  receive: "Entrada",
  adjust: "Ajuste",
  reserve: "Reserva",
  release: "Reserva liberada",
  ship: "Despacho",
};

let rows = $state<StockRow[]>([]);
let locations = $state<StockLocation[]>([]);
let movements = $state<StockMovement[]>([]);
let locationFilter = $state("");
let loading = $state(true);

let canMove = $derived(auth.canEditCatalog);
let rowByVariant = $derived(new Map(rows.map((r) => [r.variant_id, r])));
let locationName = $derived(new Map(locations.map((l) => [l.id, l.name])));

async function load() {
  loading = true;
  try {
    const query = locationFilter ? `?location_id=${locationFilter}` : "";
    [rows, locations, movements] = await Promise.all([
      fetchApi<StockRow[]>(`/api/stock${query}`),
      fetchApi<StockLocation[]>("/api/stock/locations"),
      fetchApi<StockMovement[]>("/api/stock/movements?limit=20"),
    ]);
  } catch (e) {
    toast.error(
      e instanceof Error ? e.message : "No se pudo cargar el inventario",
    );
  } finally {
    loading = false;
  }
}

// A product page links here with `?variant=` to register that variant's stock.
let requestedVariant = page.url.searchParams.get("variant");

$effect(() => {
  if (!data.user?.activeTenantId) return;
  load().then(() => {
    const row = requestedVariant && rowByVariant.get(requestedVariant);
    requestedVariant = null;
    if (row && canMove) openMove(row);
  });
});

// Manual movements. Orders reserve, release and ship on their own.
let moveOpen = $state(false);
let moving = $state(false);
let move = $state({
  variantId: "",
  kind: "receive" as "receive" | "adjust",
  quantity: "",
  locationId: "",
  note: "",
});
let moveError = $state("");

function openMove(row: StockRow | null) {
  move = {
    variantId: row?.variant_id ?? "",
    kind: "receive",
    quantity: "",
    locationId:
      locationFilter || (locations.length === 1 ? locations[0]!.id : ""),
    note: "",
  };
  moveError = "";
  moveOpen = true;
}

function variantLabel(row: StockRow): string {
  return row.variant_name
    ? `${row.product_name} · ${row.variant_name}`
    : row.product_name;
}

function moveProblem(quantity: number): string {
  if (!move.variantId) return "Elige una variante";
  if (!Number.isInteger(quantity) || quantity === 0)
    return "Escribe una cantidad entera distinta de cero";
  if (move.kind === "receive" && quantity < 0)
    return "Una entrada suma unidades: usa un ajuste para restar";
  if (locations.length > 1 && !move.locationId) return "Elige la ubicación";
  return "";
}

async function submitMove() {
  const quantity = Number(move.quantity);
  moveError = moveProblem(quantity);
  if (moveError) return;

  moving = true;
  try {
    await fetchApi("/api/stock/movements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variant_id: move.variantId,
        location_id: move.locationId || undefined,
        kind: move.kind,
        quantity,
        note: move.note.trim() || null,
      }),
    });
    toast.success("Movimiento registrado");
    moveOpen = false;
    await load();
  } catch (e) {
    moveError =
      e instanceof ApiError && e.status === 409
        ? "No hay stock suficiente en esa ubicación para restar esa cantidad"
        : e instanceof Error
          ? e.message
          : "No se pudo registrar el movimiento";
  } finally {
    moving = false;
  }
}

// New location.
let locationOpen = $state(false);
let locationDraft = $state("");
let locationError = $state("");

async function createLocation() {
  if (!locationDraft.trim()) {
    locationError = "Escribe un nombre";
    return;
  }
  try {
    await fetchApi("/api/stock/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: locationDraft.trim() }),
    });
    toast.success("Ubicación creada");
    locationOpen = false;
    await load();
  } catch (e) {
    locationError =
      e instanceof ApiError && e.status === 409
        ? "Ya existe una ubicación con ese nombre"
        : "No se pudo crear la ubicación";
  }
}

let variantItems = $derived(
  rows.map((r) => ({
    value: r.variant_id,
    label: `${variantLabel(r)} (${r.sku})`,
  })),
);
let locationItems = $derived(
  locations.map((l) => ({ value: l.id, label: l.name })),
);

const columns = [
  { header: "Producto", cell: productCell },
  {
    header: "SKU",
    key: "sku" as const,
    class: "font-mono text-sm whitespace-nowrap text-fg-muted",
  },
  {
    header: "Precio",
    cell: priceCell,
    align: "right" as const,
    class: "max-md:hidden",
  },
  { header: "Disponible", cell: availableCell, align: "right" as const },
  { header: "Reservado", cell: reservedCell, align: "right" as const },
  { header: "En mano", cell: onHandCell, align: "right" as const },
];

const movementColumns = [
  { header: "Fecha", cell: dateCell },
  { header: "Variante", cell: movementVariantCell },
  { header: "Tipo", cell: kindCell },
  { header: "Cantidad", cell: quantityCell, align: "right" as const },
  { header: "Ubicación", cell: locationCell },
];
</script>

<PageTitle title="Inventario" />

<Page>
	{#if !data.user?.activeTenantId}
		<PageHeader title="Inventario" />
		<NeedsTenant />
	{:else}
		<PageHeader title="Inventario" subtitle="Cuántas unidades hay de cada variante y qué movió el stock.">
			{#snippet actions()}
				{#if locations.length > 1}
					<Select
						id="location-filter"
						bind:value={locationFilter}
						items={[{ value: "", label: "Todas las ubicaciones" }, ...locationItems]}
						onchange={() => load()}
						class="w-56"
					/>
				{/if}
				{#if canMove}
					<Button size="sm" variant="secondary" onclick={() => { locationDraft = ""; locationError = ""; locationOpen = true; }}>
						Nueva ubicación
					</Button>
					{#if rows.length > 0}
						<Button size="sm" onclick={() => openMove(null)}>Registrar movimiento</Button>
					{/if}
				{/if}
			{/snippet}
		</PageHeader>

		{#if !loading && rows.length === 0}
			<div class="rounded-md border border-border bg-surface">
				<EmptyState
					title="Todavía no hay variantes"
					description="El stock se lleva por variante. Crea un producto y agrégale al menos una variante con su SKU."
				>
					{#snippet action()}
						<Button href="{businessPath()}/catalog">Ir al catálogo</Button>
					{/snippet}
				</EmptyState>
			</div>
		{:else}
			<div class="flex flex-col gap-6">
				<div class="rounded-md border border-border bg-surface">
					<DataTable
						data={rows}
						{columns}
						{loading}
						keyField="variant_id"
						onRowClick={canMove ? openMove : undefined}
					/>
				</div>

				{#if movements.length > 0}
					<SectionShell title="Últimos movimientos" description="Cada cambio de stock queda registrado. No se edita ni se borra: un error se corrige con un ajuste.">
						<DataTable data={movements} columns={movementColumns} keyField="id" />
					</SectionShell>
				{/if}
			</div>
		{/if}
	{/if}
</Page>

<Modal bind:open={moveOpen} title="Registrar movimiento" onClose={() => (moveOpen = false)}>
	<FormField label="Variante" for="move-variant">
		<Select id="move-variant" bind:value={move.variantId} items={variantItems} placeholder="Elige una variante" />
	</FormField>
	<div class="grid grid-cols-2 gap-x-4">
		<FormField label="Tipo" for="move-kind">
			<Select
				id="move-kind"
				bind:value={move.kind}
				items={[
					{ value: "receive", label: "Entrada (llegó mercadería)" },
					{ value: "adjust", label: "Ajuste (conteo)" },
				]}
			/>
		</FormField>
		<FormField label="Cantidad" for="move-quantity">
			<Input id="move-quantity" bind:value={move.quantity} inputmode="numeric" placeholder={move.kind === "adjust" ? "Ej. -2" : "Ej. 10"} />
		</FormField>
	</div>
	{#if locations.length > 1}
		<FormField label="Ubicación" for="move-location">
			<Select id="move-location" bind:value={move.locationId} items={locationItems} placeholder="Elige la ubicación" />
		</FormField>
	{/if}
	<FormField label="Nota" for="move-note">
		<Input id="move-note" bind:value={move.note} placeholder="Ej. Factura 001-2345" />
	</FormField>
	{#if move.kind === "adjust"}
		<p class="mb-4 text-sm text-fg-muted">Un ajuste suma o resta: escribe -2 si contaste dos unidades menos.</p>
	{/if}
	{#if moveError}
		<p role="alert" class="text-sm text-danger-text">{moveError}</p>
	{/if}

	{#snippet footer()}
		<Button variant="secondary" onclick={() => (moveOpen = false)} disabled={moving}>Cancelar</Button>
		<Button onclick={submitMove} disabled={moving}>{moving ? "Registrando…" : "Registrar"}</Button>
	{/snippet}
</Modal>

<Modal bind:open={locationOpen} title="Nueva ubicación" subtitle="Un almacén o tienda donde guardas mercadería." onClose={() => (locationOpen = false)}>
	<FormField label="Nombre" for="location-name" error={locationError}>
		<Input id="location-name" bind:value={locationDraft} placeholder="Ej. Tienda Miraflores" />
	</FormField>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (locationOpen = false)}>Cancelar</Button>
		<Button onclick={createLocation}>Crear</Button>
	{/snippet}
</Modal>

{#snippet productCell(r: StockRow)}
	<span class="text-fg">{r.product_name}</span>
	{#if r.variant_name}<span class="text-fg-muted"> · {r.variant_name}</span>{/if}
{/snippet}

{#snippet priceCell(r: StockRow)}
	<span class="text-fg-muted tabular-nums">{formatCents(r.price_cents)}</span>
{/snippet}

{#snippet availableCell(r: StockRow)}
	{#if r.available === 0}
		<Badge variant="error">Agotado</Badge>
	{:else}
		<span class="font-medium text-fg tabular-nums">{r.available}</span>
	{/if}
{/snippet}

{#snippet reservedCell(r: StockRow)}
	<span class="text-fg-muted tabular-nums">{r.reserved}</span>
{/snippet}

{#snippet onHandCell(r: StockRow)}
	<span class="text-fg-muted tabular-nums">{r.on_hand}</span>
{/snippet}

{#snippet dateCell(m: StockMovement)}
	<span class="text-sm text-fg-muted">{formatDateTime(m.created_at)}</span>
{/snippet}

{#snippet movementVariantCell(m: StockMovement)}
	{@const row = rowByVariant.get(m.variant_id)}
	<span class="text-fg">{row ? variantLabel(row) : "–"}</span>
	{#if m.note}<span class="block text-sm text-fg-muted">{m.note}</span>{/if}
{/snippet}

{#snippet kindCell(m: StockMovement)}
	<Badge>{KIND_LABELS[m.kind]}</Badge>
{/snippet}

{#snippet quantityCell(m: StockMovement)}
	<span class="tabular-nums {m.quantity > 0 ? 'text-success-text' : 'text-fg'}">{m.quantity > 0 ? "+" : ""}{m.quantity}</span>
{/snippet}

{#snippet locationCell(m: StockMovement)}
	<span class="text-sm text-fg-muted">{locationName.get(m.location_id) ?? "–"}</span>
{/snippet}
