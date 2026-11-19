<script lang="ts">
import type { Bundle } from "@vendeya/types";
import Badge from "#lib/components/ui/badge.svelte";
import { formatPrice } from "#lib/utils/formatters.js";
import StockBadge from "./stock-badge.svelte";

type Props = {
  bundles: Bundle[];
  canEdit: boolean;
  onBundleClick?: (bundle: Bundle) => void;
  onStockUpdate: (bundleId: string, status: any) => void;
};

let { bundles, canEdit, onBundleClick, onStockUpdate }: Props = $props();

function getCompositionCount(json: string): number {
  try {
    const comp = JSON.parse(json);
    const fixedCount = comp.fixed?.length || 0;
    const choiceCount = comp.choices
      ? comp.choices.reduce((acc: number, c: any) => acc + c.pick, 0)
      : 0;
    return fixedCount + choiceCount;
  } catch {
    return 0;
  }
}

function getInstallmentsText(json: string): string {
  try {
    const sched = JSON.parse(json);
    if (Array.isArray(sched) && sched.length > 0) {
      return `${sched[0].months} cuotas`;
    }
  } catch {}
  return "";
}
</script>

<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
	{#each bundles as bundle (bundle.id)}
		{@const installments = getInstallmentsText(bundle.installments_json)}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="flex h-full flex-col overflow-hidden rounded-md border border-border bg-surface transition-colors duration-150 {canEdit
				? 'cursor-pointer hover:border-border-strong'
				: ''}"
			onclick={() => canEdit && onBundleClick?.(bundle)}
		>
			<div class="relative aspect-video w-full overflow-hidden border-b border-border-subtle bg-sunken">
				<img
					src="/media/{bundle.tenant_id}/images/{bundle.image_id}.jpg"
					alt={bundle.name}
					class="size-full object-cover {bundle.is_active === 0 ? 'opacity-40 grayscale' : ''}"
					onerror={(e) => {
						const target = e.currentTarget;
						if (target instanceof HTMLImageElement) {
							target.src = "/placeholder.svg";
						}
					}}
				/>
				{#if bundle.is_active === 0}
					<Badge class="absolute top-2 left-2">Inactivo</Badge>
				{/if}
			</div>

			<div class="flex flex-1 flex-col gap-2 p-3">
				<div class="flex items-start justify-between gap-2">
					<h3 class="line-clamp-2 text-base font-medium text-fg">{bundle.name}</h3>
					<span class="shrink-0 text-base text-fg tabular-nums">S/ {formatPrice(bundle.price)}</span>
				</div>

				<div class="flex items-center justify-between gap-2">
					<span class="truncate text-sm text-fg-muted">{bundle.primary_category}</span>
					<div onclick={(e) => e.stopPropagation()} role="presentation">
						<StockBadge
							bundleId={bundle.id}
							bundleName={bundle.name}
							stockStatus={bundle.stock_status}
							{canEdit}
							onUpdate={(s) => onStockUpdate(bundle.id, s)}
						/>
					</div>
				</div>

				<p class="mt-auto border-t border-border-subtle pt-2 text-sm text-fg-muted">
					{getCompositionCount(bundle.composition_json)} piezas incluidas{installments ? ` · ${installments}` : ""}
				</p>
			</div>
		</div>
	{/each}
</div>
