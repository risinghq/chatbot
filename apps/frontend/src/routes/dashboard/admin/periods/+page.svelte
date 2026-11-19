<script lang="ts">
import { onMount } from "svelte";
import type { CatalogPeriod } from "@vendeya/types";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import Badge from "#lib/components/ui/badge.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";

type Action = "publish" | "archive" | "delete";

let periods = $state<CatalogPeriod[]>([]);
let loading = $state(true);

let creating = $state(false);
let newName = $state("");
let newMonth = $state("");

// One confirmation dialog serves every state change; `pending` says which.
let pending = $state<{ action: Action; period: CatalogPeriod } | null>(null);
let confirming = $state(false);

const activePeriod = $derived(periods.find((p) => p.status === "active"));

const statusLabels: Record<string, string> = {
  active: "Activo",
  draft: "Borrador",
  archived: "Archivado",
};
const statusVariants: Record<string, "success" | "warning" | "default"> = {
  active: "success",
  draft: "warning",
  archived: "default",
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

async function loadPeriods() {
  loading = true;
  try {
    periods = await fetchApi<CatalogPeriod[]>("/api/periods");
  } catch (err) {
    toast.error(errorMessage(err, "Error al cargar los periodos"));
  } finally {
    loading = false;
  }
}

function openCreate() {
  newName = "";
  newMonth = new Date().toISOString().slice(0, 7);
  creating = true;
}

async function create(e: Event) {
  e.preventDefault();
  try {
    const period = await fetchApi<CatalogPeriod>("/api/periods", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, year_month: newMonth }),
    });
    periods = [period, ...periods].sort((a, b) =>
      b.year_month.localeCompare(a.year_month),
    );
    toast.success("Periodo creado");
    creating = false;
  } catch (err) {
    toast.error(errorMessage(err, "Error al crear el periodo"));
  }
}

async function setStatus(period: CatalogPeriod, status: "active" | "archived") {
  const updated = await fetchApi<CatalogPeriod>(
    `/api/periods/${period.id}/status`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  // Publishing archives the previous active period on the server.
  periods = periods.map((p) => {
    if (p.id === updated.id) return updated;
    if (status === "active" && p.status === "active")
      return { ...p, status: "archived" as const };
    return p;
  });
}

async function confirm() {
  if (!pending) return;
  const { action, period } = pending;
  confirming = true;
  try {
    if (action === "publish") {
      await setStatus(period, "active");
      toast.success(`${period.name} publicado`);
    } else if (action === "archive") {
      await setStatus(period, "archived");
      toast.success(`${period.name} archivado`);
    } else {
      await fetchApi(`/api/periods/${period.id}`, { method: "DELETE" });
      periods = periods.filter((p) => p.id !== period.id);
      toast.success(`${period.name} eliminado`);
    }
    pending = null;
  } catch (err) {
    toast.error(errorMessage(err, "No se pudo completar la acción"));
  } finally {
    confirming = false;
  }
}

const confirmTitles: Record<Action, string> = {
  publish: "Publicar periodo",
  archive: "Archivar periodo",
  delete: "Eliminar borrador",
};
const confirmLabels: Record<Action, string> = {
  publish: "Publicar",
  archive: "Archivar",
  delete: "Eliminar",
};

onMount(loadPeriods);
</script>

<SectionShell
	title="Periodos de catálogo"
	description="Cada periodo es un catálogo. El bot vende solo los productos del periodo activo."
	action={creating ? undefined : createAction}
>
	{#if creating}
		<form class="border-b border-border-subtle" onsubmit={create}>
			<div class="grid gap-x-4 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<FormField label="Nombre" for="period-name" class="md:mb-0!">
					<Input id="period-name" bind:value={newName} placeholder="Campaña escolar 2026" />
				</FormField>
				<FormField label="Mes" for="period-month" class="mb-0!">
					<Input id="period-month" type="month" bind:value={newMonth} />
				</FormField>
			</div>
			<footer class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
				<Button variant="ghost" onclick={() => (creating = false)}>Cancelar</Button>
				<Button type="submit" disabled={!newName || !newMonth}>Crear periodo</Button>
			</footer>
		</form>
	{/if}

	{#if loading}
		<div class="flex flex-col gap-3 p-4" aria-busy="true">
			<div class="h-8 animate-pulse rounded-sm bg-sunken"></div>
			<div class="h-8 animate-pulse rounded-sm bg-sunken"></div>
		</div>
	{:else if periods.length === 0}
		<EmptyState
			title="Sin periodos"
			description="Crea un periodo, carga sus productos en el catálogo y publícalo para que el bot venda."
		/>
	{:else}
		<ul class="divide-y divide-border-subtle">
			{#each periods as period (period.id)}
				<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
					<div class="min-w-0">
						<p class="truncate text-base text-fg">{period.name}</p>
						<p class="text-sm text-fg-muted tabular-nums">{period.year_month}</p>
					</div>
					<div class="flex items-center gap-2">
						<Badge variant={statusVariants[period.status] ?? "default"}>
							{statusLabels[period.status] ?? period.status}
						</Badge>
						{#if period.status === "draft"}
							<Button size="sm" variant="ghost" onclick={() => (pending = { action: "delete", period })}>
								Eliminar
							</Button>
							<Button size="sm" onclick={() => (pending = { action: "publish", period })}>Publicar</Button>
						{:else if period.status === "active"}
							<Button size="sm" variant="secondary" onclick={() => (pending = { action: "archive", period })}>
								Archivar
							</Button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</SectionShell>

{#snippet createAction()}
	<Button size="sm" variant="secondary" onclick={openCreate}>Nuevo periodo</Button>
{/snippet}

<Modal
	open={pending !== null}
	onClose={() => (pending = null)}
	title={pending ? confirmTitles[pending.action] : ""}
>
	{#if pending}
		<div class="flex flex-col gap-3 text-base text-fg">
			{#if pending.action === "publish"}
				<p>El bot empieza a vender los productos de <strong class="font-medium">{pending.period.name}</strong> en cuanto lo publiques.</p>
				{#if activePeriod}
					<Banner tone="warning">{activePeriod.name} pasa a archivado.</Banner>
				{/if}
				<p class="text-fg-muted">Revisa que el catálogo de este periodo esté completo.</p>
			{:else if pending.action === "archive"}
				<p><strong class="font-medium">{pending.period.name}</strong> deja de estar a la venta.</p>
				<Banner tone="warning">El bot no vende nada hasta que publiques otro periodo.</Banner>
			{:else}
				<p>Se elimina <strong class="font-medium">{pending.period.name}</strong> para siempre.</p>
				<p class="text-fg-muted">Solo se puede eliminar un borrador sin productos. Si tiene productos, quítalos antes desde el catálogo.</p>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (pending = null)}>Cancelar</Button>
		<Button
			variant={pending?.action === "delete" ? "danger" : "primary"}
			onclick={confirm}
			disabled={confirming}
		>
			{pending ? confirmLabels[pending.action] : ""}
		</Button>
	{/snippet}
</Modal>
