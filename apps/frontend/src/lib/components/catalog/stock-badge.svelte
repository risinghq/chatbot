<script lang="ts">
import type { StockStatus } from "@vendeya/types";
import { toast } from "#lib/state/toast.svelte.js";
import { updateBundleStock } from "#lib/utils/catalog.js";
import Dropdown from "#lib/components/ui/dropdown.svelte";
import DropdownTrigger from "#lib/components/ui/dropdown-trigger.svelte";
import DropdownMenu from "#lib/components/ui/dropdown-menu.svelte";
import DropdownItem from "#lib/components/ui/dropdown-item.svelte";

type Props = {
  bundleId: string;
  bundleName: string;
  stockStatus: StockStatus;
  canEdit: boolean;
  onUpdate: (newStatus: StockStatus) => void;
};

let { bundleId, bundleName, stockStatus, canEdit, onUpdate }: Props = $props();

let open = $state(false);
let isUpdating = $state(false);

const statusConfig = {
  in_stock: { label: "En stock", class: "bg-success-soft text-success-text" },
  low_stock: {
    label: "Stock bajo",
    class: "bg-warning-soft text-warning-text",
  },
  out_of_stock: { label: "Agotado", class: "bg-sunken text-fg-muted" },
};

async function updateStatus(newStatus: StockStatus) {
  if (isUpdating || newStatus === stockStatus) {
    open = false;
    return;
  }

  isUpdating = true;
  try {
    await updateBundleStock(bundleId, newStatus);
    onUpdate(newStatus);
    toast.success(`${bundleName}: ${statusConfig[newStatus].label}`);
  } catch (error) {
    toast.error(`Error al actualizar ${bundleName}`);
  } finally {
    isUpdating = false;
    open = false;
  }
}
</script>

<Dropdown bind:open>
	<DropdownTrigger
		onclick={() => canEdit && !isUpdating && (open = !open)}
		disabled={!canEdit || isUpdating}
		class="inline-flex h-6 items-center gap-1 rounded-sm px-2 text-xs font-medium whitespace-nowrap transition-colors pointer-coarse:h-9 {statusConfig[stockStatus].class} {canEdit ? 'cursor-pointer hover:brightness-95' : 'cursor-default'}"
	>
		<span>{statusConfig[stockStatus].label}</span>
		{#if canEdit}
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="size-3" aria-hidden="true">
				<polyline points="6 9 12 15 18 9"/>
			</svg>
		{/if}
	</DropdownTrigger>

	<DropdownMenu {open} class="left-0">
		{#each Object.entries(statusConfig) as [status, config] (status)}
			<DropdownItem
				onclick={() => updateStatus(status as StockStatus)}
				disabled={isUpdating || status === stockStatus}
			>
				{config.label}
			</DropdownItem>
		{/each}
	</DropdownMenu>
</Dropdown>
