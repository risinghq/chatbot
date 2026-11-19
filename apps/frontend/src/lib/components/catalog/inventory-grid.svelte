<script lang="ts">
import type { Product } from "@vendeya/types";
import Badge from "#lib/components/ui/badge.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";

type Props = {
  products: Product[];
  canEdit: boolean;
  onProductClick?: (product: Product) => void;
};

let { products, canEdit, onProductClick }: Props = $props();

// `specs_json` is a flat object written by the catalog import. A value that
// does not parse shows as stored.
function formatSpecs(json: string | null): string {
  if (!json) return "–";
  try {
    const entries = Object.entries(JSON.parse(json) as Record<string, unknown>);
    if (entries.length === 0) return "–";
    return entries
      .map(([key, value]) => (value === true ? key : `${key} ${value}`))
      .join(" · ");
  } catch {
    return json;
  }
}

const columns = [
  { header: "Nombre", key: "name" as const, class: "text-fg" },
  { header: "Categoría", cell: categoryCell },
  { header: "Marca / Modelo", cell: brandCell },
  { header: "Specs", cell: specsCell },
];
</script>

<div class="rounded-md border border-border bg-surface">
	<DataTable
		data={products}
		{columns}
		emptyMessage="No hay productos base registrados."
		onRowClick={canEdit ? onProductClick : undefined}
	/>
</div>

{#snippet categoryCell(p: Product)}
	<Badge>{p.category}</Badge>
{/snippet}

{#snippet brandCell(p: Product)}
	<span class="text-fg-muted">{p.brand || "–"}{p.model ? ` / ${p.model}` : ""}</span>
{/snippet}

{#snippet specsCell(p: Product)}
	<span class="block max-w-md truncate text-sm text-fg-muted">{formatSpecs(p.specs_json)}</span>
{/snippet}
