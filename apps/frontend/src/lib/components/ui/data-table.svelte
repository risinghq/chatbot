<script lang="ts" generics="T extends Record<string, any>">
import type { Snippet } from "svelte";

type Column<T> = {
  header: string;
  key?: keyof T;
  // A snippet, not a string: Svelte escapes every value the snippet
  // interpolates, so a stored value can never reach the DOM as markup.
  cell?: Snippet<[T]>;
  class?: string;
  align?: "left" | "center" | "right";
};

type Props<T> = {
  data: T[];
  columns: Column<T>[];
  keyField?: keyof T;
  emptyMessage?: string;
  loading?: boolean;
  onRowClick?: (item: T) => void;
};

let {
  data,
  columns,
  keyField = "id" as keyof T,
  emptyMessage = "No hay datos disponibles",
  loading = false,
  onRowClick,
}: Props<T> = $props();

const alignClass = { left: "text-left", center: "text-center", right: "text-right" };
</script>

<div class="overflow-x-auto">
	<table class="w-full text-left text-base">
		<thead class="border-b border-border-subtle text-sm text-fg-muted">
			<tr>
				{#each columns as col}
					<th class="h-9 px-4 font-medium whitespace-nowrap select-none {col.class || ''} {alignClass[col.align || 'left']}">
						{col.header}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody class="divide-y divide-border-subtle">
			{#if loading}
				{#each Array(3) as _}
					<tr class="h-10 animate-pulse">
						{#each columns as _col}
							<td class="px-4"><div class="h-3 w-2/3 rounded-sm bg-sunken"></div></td>
						{/each}
					</tr>
				{/each}
			{:else if data.length === 0}
				<tr>
					<td colspan={columns.length} class="px-4 py-10 text-center text-fg-muted">{emptyMessage}</td>
				</tr>
			{:else}
				{#each data as item (item[keyField])}
					<tr
						class="h-10 transition-colors duration-150 hover:bg-hover {onRowClick ? 'cursor-pointer' : ''}"
						onclick={() => onRowClick?.(item)}
					>
						{#each columns as col}
							<td class="relative px-4 py-2 {col.class || ''} {alignClass[col.align || 'left']}">
								{#if col.cell}
									{@render col.cell(item)}
								{:else if col.key}
									{item[col.key]}
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>
