<script lang="ts">
import type { StockRow } from "@vendeya/types";
import Input from "#lib/components/ui/input.svelte";
import { formatCents } from "#lib/utils/money.js";
import { variantLabel } from "#lib/utils/order-draft.js";

type Props = {
  /** Stock of the order's location. */
  rows: StockRow[];
  onadd: (row: StockRow) => void;
};

let { rows, onadd }: Props = $props();

const SHOWN = 8;

let query = $state("");

const matches = $derived.by(() => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return rows
    .filter(
      (r) =>
        r.is_active && `${variantLabel(r)} ${r.sku}`.toLowerCase().includes(q),
    )
    .slice(0, SHOWN);
});

function add(row: StockRow) {
  onadd(row);
  query = "";
}
</script>

<Input id="order-product" bind:value={query} placeholder="Buscar producto o SKU" autocomplete="off" />
{#if matches.length > 0}
	<ul class="mt-2 divide-y divide-border-subtle rounded-md border border-border-subtle">
		{#each matches as row (row.variant_id)}
			<li>
				<button
					type="button"
					class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-hover pointer-coarse:min-h-11"
					onclick={() => add(row)}
				>
					<span class="min-w-0">
						<span class="block truncate text-fg">{variantLabel(row)}</span>
						<span class="block font-mono text-sm text-fg-muted">{row.sku}</span>
					</span>
					<span class="shrink-0 text-right">
						<span class="block tabular-nums text-fg">{formatCents(row.price_cents)}</span>
						<span class="block text-sm {row.available > 0 ? 'text-fg-muted' : 'text-danger-text'}">
							{row.available > 0 ? `${row.available} disponibles` : "Sin stock"}
						</span>
					</span>
				</button>
			</li>
		{/each}
	</ul>
{:else if query.trim()}
	<p class="mt-2 text-sm text-fg-muted">Ningún producto activo coincide.</p>
{/if}
