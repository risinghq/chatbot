<script lang="ts">
import type { CatalogPeriod } from "@vendeya/types";
import { fieldStyles } from "#lib/components/ui/field-styles.js";

type Props = {
  periods: CatalogPeriod[];
  selected: CatalogPeriod | null;
  onSelect: (period: CatalogPeriod) => void;
};

let { periods, selected, onSelect }: Props = $props();

const statusLabels: Record<string, string> = {
  draft: "Borrador",
  active: "Activo",
  archived: "Archivado",
};
</script>

<select
	aria-label="Periodo"
	class="{fieldStyles(false)} h-8 w-auto py-0 pr-8 pointer-coarse:h-11"
	value={selected?.id || ""}
	onchange={(e) => {
		const period = periods.find((p) => p.id === e.currentTarget.value);
		if (period) onSelect(period);
	}}
>
	{#each periods as period (period.id)}
		<option value={period.id}>
			{period.name} ({statusLabels[period.status] ?? period.status})
		</option>
	{/each}
</select>
