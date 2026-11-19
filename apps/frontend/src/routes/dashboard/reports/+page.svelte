<script lang="ts">
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { toast } from "#lib/state/toast.svelte.js";
import { limaDateString } from "#lib/utils/formatters.js";
import { orderStatusLabels } from "#lib/utils/order-status.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

const DAY_MS = 24 * 60 * 60 * 1000;

let startDate = $state(limaDateString());
let endDate = $state(limaDateString());
let segments = $state<Record<string, boolean>>({
  fnb: true,
  gaso: true,
  none: true,
});
// No status picked means every status.
let saleStatuses = $state<Record<string, boolean>>({
  confirmed: false,
  pending: false,
  rejected: false,
});
let generating = $state(false);

let orderStartDate = $state("");
let orderEndDate = $state("");
let orderStatus = $state("");
let generatingOrders = $state(false);

const segmentLabels: Record<string, string> = {
  fnb: "FNB",
  gaso: "GASO",
  none: "Sin segmento",
};
const saleStatusLabels: Record<string, string> = {
  confirmed: "Confirmados",
  pending: "Pendientes",
  rejected: "Rechazados",
};
const orderStatusItems = Object.entries(orderStatusLabels).map(
  ([value, label]) => ({ value, label }),
);

const presets = [
  { label: "Hoy", from: 0, to: 0 },
  { label: "Ayer", from: 1, to: 1 },
  { label: "7 días", from: 7, to: 0 },
  { label: "30 días", from: 30, to: 0 },
];

function applyPreset(from: number, to: number) {
  const now = Date.now();
  startDate = limaDateString(now - from * DAY_MS);
  endDate = limaDateString(now - to * DAY_MS);
}

function picked(set: Record<string, boolean>): string[] {
  return Object.keys(set).filter((key) => set[key]);
}

// The API answers with the workbook; the browser saves it under `filename`.
async function download(url: string, filename: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}

async function generateActivity(e: Event) {
  e.preventDefault();
  const statuses = picked(saleStatuses);
  const params = new URLSearchParams({
    startDate,
    endDate,
    segments: picked(segments).join(","),
    saleStatuses: statuses.length ? statuses.join(",") : "all",
  });
  generating = true;
  try {
    await download(
      `/api/reports/activity?${params}`,
      `reporte-actividad-${startDate}-a-${endDate}.xlsx`,
    );
  } catch {
    toast.error("No se pudo generar el reporte de actividad");
  } finally {
    generating = false;
  }
}

async function generateOrders(e: Event) {
  e.preventDefault();
  const params = new URLSearchParams();
  if (orderStartDate) params.append("startDate", orderStartDate);
  if (orderEndDate) params.append("endDate", orderEndDate);
  if (orderStatus) params.append("status", orderStatus);
  const range = orderStartDate
    ? `${orderStartDate}-a-${orderEndDate || "hoy"}`
    : "todas";
  generatingOrders = true;
  try {
    await download(
      `/api/reports/orders?${params}`,
      `reporte-ordenes-${range}.xlsx`,
    );
  } catch {
    toast.error("No se pudo generar el reporte de órdenes");
  } finally {
    generatingOrders = false;
  }
}
</script>

<PageTitle title="Reportes" />

<div class="mx-auto max-w-3xl px-4 py-6 md:px-8 md:py-8">
	<PageHeader title="Reportes" subtitle="Descarga los datos en Excel." />

	<div class="flex flex-col gap-6">
		<form onsubmit={generateActivity}>
			<SectionShell
				title="Actividad"
				description="Cada cliente que escribió al bot, con los datos que dio, haya comprado o no."
			>
				<div class="flex flex-col gap-5 p-4">
					<div>
						<div class="mb-3 flex flex-wrap gap-1.5">
							{#each presets as preset (preset.label)}
								<Button size="sm" variant="secondary" onclick={() => applyPreset(preset.from, preset.to)}>
									{preset.label}
								</Button>
							{/each}
						</div>
						{@render dateRange("activity", startDate, endDate, (v) => (startDate = v), (v) => (endDate = v))}
					</div>

					<fieldset>
						<legend class="mb-1.5 text-sm text-fg-muted">Segmento</legend>
						<div class="flex flex-wrap gap-1.5">
							{#each Object.entries(segmentLabels) as [key, label] (key)}
								{@render chip(label, segments[key] ?? false, (v) => (segments[key] = v))}
							{/each}
						</div>
					</fieldset>

					<fieldset>
						<legend class="mb-1.5 text-sm text-fg-muted">Estado de venta · ninguno marcado incluye todos</legend>
						<div class="flex flex-wrap gap-1.5">
							{#each Object.entries(saleStatusLabels) as [key, label] (key)}
								{@render chip(label, saleStatuses[key] ?? false, (v) => (saleStatuses[key] = v))}
							{/each}
						</div>
					</fieldset>
				</div>
				<footer class="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
					<p class="text-sm text-fg-muted">
						Contactos de hoy: <span class="text-fg tabular-nums">{data.todayCount}</span>
					</p>
					<Button type="submit" disabled={generating || picked(segments).length === 0}>
						{generating ? "Generando…" : "Descargar Excel"}
					</Button>
				</footer>
			</SectionShell>
		</form>

		<form onsubmit={generateOrders}>
			<SectionShell
				title="Órdenes"
				description="Cada orden con su estado, monto y aprobaciones. Sin fechas, incluye todas."
			>
				<div class="flex flex-col gap-4 p-4">
					{@render dateRange("orders", orderStartDate, orderEndDate, (v) => (orderStartDate = v), (v) => (orderEndDate = v))}
					<FormField label="Estado" for="order-status" class="mb-0! max-w-xs">
						<Select
							id="order-status"
							bind:value={orderStatus}
							items={[{ value: "", label: "Todos los estados" }, ...orderStatusItems]}
						/>
					</FormField>
				</div>
				<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
					<Button type="submit" disabled={generatingOrders}>
						{generatingOrders ? "Generando…" : "Descargar Excel"}
					</Button>
				</footer>
			</SectionShell>
		</form>
	</div>
</div>

{#snippet dateRange(
	id: string,
	from: string,
	to: string,
	setFrom: (value: string) => void,
	setTo: (value: string) => void,
)}
	<div class="grid max-w-md grid-cols-2 gap-3">
		<FormField label="Desde" for="{id}-from" class="mb-0!">
			<Input id="{id}-from" type="date" value={from} oninput={(e) => setFrom(e.currentTarget.value)} />
		</FormField>
		<FormField label="Hasta" for="{id}-to" class="mb-0!">
			<Input id="{id}-to" type="date" value={to} oninput={(e) => setTo(e.currentTarget.value)} />
		</FormField>
	</div>
{/snippet}

{#snippet chip(label: string, checked: boolean, set: (value: boolean) => void)}
	<label
		class="flex h-7 cursor-pointer items-center rounded-sm border border-border px-2.5 text-sm text-fg-muted transition-colors duration-150 ease-out hover:bg-hover has-checked:border-accent has-checked:bg-accent-soft has-checked:text-accent-text has-focus-visible:outline-2 has-focus-visible:outline-ring"
	>
		<input type="checkbox" {checked} onchange={(e) => set(e.currentTarget.checked)} class="sr-only" />
		{label}
	</label>
{/snippet}
