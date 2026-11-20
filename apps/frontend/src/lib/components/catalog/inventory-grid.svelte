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
  { header: "Nombre", key: "name" as const, class: "text-fg" },
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
		emptyMessage="Todavía no hay productos. Crea el primero con «Nuevo producto»."
		onRowClick={onProductClick}
	/>
</div>

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
