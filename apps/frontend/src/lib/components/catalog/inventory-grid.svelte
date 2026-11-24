<script lang="ts">
import type { Product, ProductStatus } from "@vendeya/types";
import Badge from "#lib/components/ui/badge.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";

type Props = {
  products: Product[];
  onProductClick: (product: Product) => void;
};

let { products, onProductClick }: Props = $props();

const STATUS: Record<
  ProductStatus,
  { label: string; variant: "success" | "default" | "warning" }
> = {
  active: { label: "Activo", variant: "success" },
  draft: { label: "Borrador", variant: "warning" },
  archived: { label: "Archivado", variant: "default" },
};

const columns = [
  { header: "Nombre", cell: nameCell },
  { header: "Categoría", cell: categoryCell },
  { header: "Marca / Modelo", cell: brandCell },
  { header: "Variantes", cell: variantsCell, align: "right" as const },
  { header: "Estado", cell: statusCell },
];
</script>

<div class="rounded-md border border-border bg-surface">
	<DataTable
		data={products}
		{columns}
		keyField="id"
		emptyMessage="Todavía no hay productos. Crea el primero con «Nuevo producto» o sube tu lista con «Importar desde Excel»."
		onRowClick={onProductClick}
	/>
</div>

{#snippet nameCell(p: Product)}
	<span class="flex items-center gap-3">
		{#if p.cover_url}
			<img src={p.cover_url} alt="" class="size-8 shrink-0 rounded-sm object-cover" loading="lazy" />
		{:else}
			<span class="size-8 shrink-0 rounded-sm bg-sunken"></span>
		{/if}
		<span class="text-fg">{p.name}</span>
	</span>
{/snippet}

{#snippet categoryCell(p: Product)}
	<Badge>{p.category}</Badge>
{/snippet}

{#snippet brandCell(p: Product)}
	<span class="text-fg-muted">{p.brand || "–"}{p.model ? ` / ${p.model}` : ""}</span>
{/snippet}

{#snippet variantsCell(p: Product)}
	<span class="tabular-nums {p.variant_count ? 'text-fg' : 'text-fg-muted'}">{p.variant_count ?? 0}</span>
{/snippet}

{#snippet statusCell(p: Product)}
	{@const status = STATUS[p.status]}
	<Badge variant={status.variant}>{status.label}</Badge>
{/snippet}
