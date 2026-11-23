<script lang="ts">
import type { ReportBusiness, ReportDay, ReportSummary } from "@vendeya/types";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { goto } from "$app/navigation";
import { apiFetch } from "#lib/utils/api.js";
import { limaDateString } from "#lib/utils/formatters.js";
import { formatCents } from "#lib/utils/money.js";

/** One business's summary, or the platform's with a line per business. */
let { scope }: { scope: "business" | "platform" } = $props();

const endpoint = $derived(
  scope === "platform" ? "/api/reports/summary/all" : "/api/reports/summary",
);

const DAY_MS = 24 * 60 * 60 * 1000;

// Each period ends today in Lima and counts today.
const periods = [
  { label: "Hoy", days: 1 },
  { label: "7 días", days: 7 },
  { label: "30 días", days: 30 },
  { label: "90 días", days: 90 },
];

let days = $state(7);
let summary = $state<ReportSummary | null>(null);
let failed = $state(false);

$effect(() => {
  const now = Date.now();
  const params = new URLSearchParams({
    startDate: limaDateString(now - (days - 1) * DAY_MS),
    endDate: limaDateString(now),
  });
  // A slow answer for an earlier period must not replace a newer one.
  let current = true;
  failed = false;
  apiFetch(`${endpoint}?${params}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<ReportSummary>;
    })
    .then((next) => {
      if (current) summary = next;
    })
    .catch(() => {
      if (current) failed = true;
    });
  return () => {
    current = false;
  };
});

const soles = (cents: number) => `S/ ${formatCents(cents)}`;
const usd = (amount: number) =>
  `US$ ${amount.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: amount < 1 ? 4 : 2 })}`;
const count = (n: number) => n.toLocaleString("es-PE");
const percent = (part: number, whole: number) =>
  whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`;

const peak = $derived(
  Math.max(1, ...(summary?.days ?? []).map((day) => day.revenueCents)),
);
const dayLabel = (date: string) => {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
};
const dayTitle = (day: ReportDay) =>
  `${dayLabel(day.date)}: ${soles(day.revenueCents)}, ${count(day.orders)} pedidos, ${count(day.contacts)} contactos`;
</script>

<SectionShell
	title="Resumen"
	description="Contactos, pedidos y gasto del asistente. Los pedidos cancelados y las simulaciones no cuentan."
>
	{#snippet action()}
		<div class="flex flex-wrap gap-1.5">
			{#each periods as period (period.days)}
				<Button
					size="sm"
					variant={days === period.days ? "primary" : "secondary"}
					onclick={() => (days = period.days)}
				>
					{period.label}
				</Button>
			{/each}
		</div>
	{/snippet}

	{#if failed}
		<p class="px-4 py-6 text-base text-fg-muted">No se pudo cargar el resumen.</p>
	{:else if !summary}
		<p class="px-4 py-6 text-base text-fg-muted">Cargando…</p>
	{:else}
		{@const s = summary}
		<div class="grid grid-cols-2 gap-px bg-border-subtle lg:grid-cols-4">
			{@render stat("Ventas", soles(s.orders.revenueCents), `${count(s.orders.count)} pedidos · ticket ${soles(s.orders.averageCents)}`)}
			{@render stat("Contactos", count(s.contacts), `${count(s.orders.buyers)} compraron · ${percent(s.orders.buyers, s.contacts)}`)}
			{@render stat("Vendido por el asistente", soles(s.orders.assistantRevenueCents), `${count(s.orders.fromAssistant)} pedidos · ${percent(s.orders.assistantRevenueCents, s.orders.revenueCents)} de las ventas`)}
			{@render stat("Gasto en IA", usd(s.ai.costUsd), `${count(s.ai.calls)} llamadas${s.ai.errors ? ` · ${count(s.ai.errors)} con error` : ""}`)}
		</div>

		{#if s.days.length > 1}
			<div class="border-t border-border-subtle px-4 py-4">
				<p class="mb-3 text-sm text-fg-muted">Ventas por día</p>
				<div class="flex h-32 items-end gap-px" role="img" aria-label="Ventas por día">
					{#each s.days as day (day.date)}
						<div class="flex h-full min-w-0 flex-1 items-end" title={dayTitle(day)}>
							<div
								class="w-full rounded-t-sm {day.revenueCents > 0 ? 'bg-accent' : 'bg-sunken-strong'}"
								style:height="{day.revenueCents > 0 ? Math.max(4, (day.revenueCents / peak) * 100) : 2}%"
							></div>
						</div>
					{/each}
				</div>
				<div class="mt-1.5 flex justify-between text-sm text-fg-subtle tabular-nums">
					<span>{dayLabel(s.startDate)}</span>
					<span>{dayLabel(s.endDate)}</span>
				</div>
			</div>
		{/if}

		<div class="border-t border-border-subtle px-4 py-4">
			<p class="mb-2 text-sm text-fg-muted">Productos más vendidos</p>
			{#if s.topProducts.length === 0}
				<p class="text-base text-fg-muted">Sin pedidos en este periodo.</p>
			{:else}
				<ol class="divide-y divide-border-subtle">
					{#each s.topProducts as product (product.name)}
						<li class="flex items-baseline justify-between gap-3 py-1.5 text-base">
							<span class="min-w-0 truncate text-fg">{product.name}</span>
							<span class="shrink-0 text-fg-muted tabular-nums">
								{count(product.quantity)} u. · {soles(product.revenueCents)}
							</span>
						</li>
					{/each}
				</ol>
			{/if}
		</div>

		{#if s.ai.unpricedCalls > 0}
			<p class="border-t border-border-subtle px-4 py-3 text-sm text-fg-muted">
				{count(s.ai.unpricedCalls)} llamadas usaron un modelo sin precio conocido y no suman al gasto.
			</p>
		{/if}
	{/if}
</SectionShell>

{#if summary?.businesses}
	<SectionShell title="Por negocio" description="Cada negocio activo en el mismo periodo. Elige uno para entrar.">
		<DataTable
			data={summary.businesses}
			keyField="tenantId"
			emptyMessage="No hay negocios activos."
			onRowClick={(b) => goto(`/dashboard/${b.tenantId}/reports`)}
			columns={[
				{ header: "Negocio", cell: nameCell },
				{ header: "Contactos", cell: contactsCell, align: "right" },
				{ header: "Pedidos", cell: ordersCell, align: "right" },
				{ header: "Ventas", cell: revenueCell, align: "right" },
				{ header: "Gasto en IA", cell: aiCell, align: "right" },
			]}
		/>
	</SectionShell>
{/if}

{#snippet stat(label: string, value: string, hint: string)}
	<div class="bg-surface px-4 py-3">
		<p class="text-sm text-fg-muted">{label}</p>
		<p class="mt-1 text-lg whitespace-nowrap text-fg tabular-nums sm:text-xl">{value}</p>
		<p class="mt-0.5 text-sm text-fg-muted tabular-nums">{hint}</p>
	</div>
{/snippet}

{#snippet nameCell(b: ReportBusiness)}
	<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
		<span class="text-fg">{b.name}</span>
		{#if !b.hasOpenAiKey}
			<Badge variant="warning">Sin clave de OpenAI</Badge>
		{/if}
	</span>
{/snippet}
{#snippet contactsCell(b: ReportBusiness)}
	<span class="tabular-nums">{count(b.contacts)}</span>
{/snippet}
{#snippet ordersCell(b: ReportBusiness)}
	<span class="tabular-nums">{count(b.orders)}</span>
{/snippet}
{#snippet revenueCell(b: ReportBusiness)}
	<span class="whitespace-nowrap tabular-nums">{soles(b.revenueCents)}</span>
{/snippet}
{#snippet aiCell(b: ReportBusiness)}
	<span class="block whitespace-nowrap tabular-nums">{usd(b.aiCostUsd)}</span>
	<span class="block text-sm whitespace-nowrap text-fg-muted tabular-nums">
		{count(b.aiCalls)} llamadas{#if b.aiErrors}
			{" · "}<span class="text-danger-text">{count(b.aiErrors)} con error</span>
		{/if}
	</span>
{/snippet}
