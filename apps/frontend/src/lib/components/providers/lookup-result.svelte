<script lang="ts">
import type { LookupResult } from "#lib/utils/provider-lookup.js";
import { formatPrice, formatDate, formatTime } from "#lib/utils/formatters.js";
import Badge from "#lib/components/ui/badge.svelte";

type Props = {
  result: LookupResult;
};

let { result }: Props = $props();

const outcomes = {
  eligible: { label: "Aprobado", variant: "success", note: "" },
  not_eligible: {
    label: "Rechazado",
    variant: "error",
    note: "El cliente no califica para una línea de crédito.",
  },
  system_outage: {
    label: "Sin respuesta",
    variant: "warning",
    note: "Ningún proveedor respondió. Intenta de nuevo más tarde.",
  },
  needs_human: {
    label: "Revisión manual",
    variant: "warning",
    note: "La consulta necesita revisión de una persona.",
  },
} as const;

// `error` is set when the backend could not run the check at all.
const outcome = $derived(
  result.error
    ? ({ label: "Error", variant: "error", note: result.error } as const)
    : outcomes[result.status ?? "needs_human"],
);

const segmentLabels = { fnb: "FNB (Retail)", gaso: "Gaso (Servicios)" };
</script>

<section class="rounded-md border border-border bg-surface">
	<header class="flex items-start justify-between gap-4 border-b border-border-subtle px-4 py-3">
		<div>
			<h2 class="text-md text-fg">Reporte de elegibilidad</h2>
			<p class="mt-0.5 text-sm text-fg-muted tabular-nums">
				{formatDate(new Date())} · {formatTime(new Date())}
			</p>
		</div>
		<Badge variant={outcome.variant}>{outcome.label}</Badge>
	</header>

	{#if result.status === "eligible"}
		<dl class="grid grid-cols-1 gap-x-6 gap-y-4 p-4 sm:grid-cols-2">
			{@render item("Nombre del cliente", result.name || "N/A")}
			{@render item("Segmento", result.segment ? segmentLabels[result.segment] : "N/A")}
			<div>
				<dt class="text-sm text-fg-muted">Línea aprobada</dt>
				<dd class="mt-0.5 text-xl text-fg tabular-nums">S/ {formatPrice(result.credit ?? 0)}</dd>
			</div>
			{#if result.nse !== undefined}
				{@render item("Nivel NSE", String(result.nse))}
			{/if}
		</dl>
	{:else}
		<p class="p-4 text-base text-fg">{outcome.note}</p>
	{/if}
</section>

{#snippet item(label: string, value: string)}
	<div>
		<dt class="text-sm text-fg-muted">{label}</dt>
		<dd class="mt-0.5 text-md text-fg">{value}</dd>
	</div>
{/snippet}
