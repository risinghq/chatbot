<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import type { Customer, CustomerSummary } from "@vendeya/types";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import CustomerFields from "#lib/components/orders/customer-fields.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import Input from "#lib/components/ui/input.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import {
  customerBody,
  customerForm,
  customerFormProblems,
} from "#lib/utils/customer-form.js";
import { formatPhone } from "#lib/utils/formatters.js";
import { formatCents } from "#lib/utils/money.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let search = $state(page.url.searchParams.get("q") ?? "");
let open = $state(false);
let form = $state(customerForm());
let errors = $state<ReturnType<typeof customerFormProblems>>({});
let isSaving = $state(false);

const canCreate = $derived(auth.canTakeOrders);

const columns = [
  { header: "Cliente", cell: nameCell },
  { header: "Teléfono", cell: phoneCell },
  { header: "Pedidos", cell: ordersCell, align: "right" as const },
  { header: "Compró", cell: spentCell, align: "right" as const },
];

function applySearch(event: SubmitEvent) {
  event.preventDefault();
  const q = search.trim();
  goto(
    q
      ? `${businessPath()}/clientes?q=${encodeURIComponent(q)}`
      : businessPath("/clientes"),
  );
}

function openCreate() {
  form = customerForm();
  errors = {};
  open = true;
}

async function create() {
  errors = customerFormProblems(form);
  if (Object.keys(errors).length > 0) return;
  isSaving = true;
  try {
    const customer = await fetchApi<Customer>("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(customerBody(form)),
    });
    open = false;
    toast.success("Cliente creado");
    await goto(`${businessPath()}/clientes/${customer.id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      errors = { phone: "Otro cliente ya tiene este teléfono" };
    else toast.error("No se pudo crear el cliente");
  } finally {
    isSaving = false;
  }
}
</script>

<PageTitle title="Clientes" />

<Page>
	<PageHeader title="Clientes" subtitle="Quién te compra, cómo contactarlo y dónde entregarle.">
		{#snippet actions()}
			{#if canCreate}
				<Button onclick={openCreate}>Nuevo cliente</Button>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="rounded-md border border-border bg-surface">
		<form class="flex gap-2 border-b border-border-subtle p-4" role="search" onsubmit={applySearch}>
			<Input id="customer-search" bind:value={search} placeholder="Buscar por nombre o teléfono" class="max-w-sm" />
			<Button type="submit" size="sm" variant="secondary">Buscar</Button>
		</form>

		{#if data.customers.length === 0}
			<EmptyState
				title={data.search ? "Sin resultados" : "Sin clientes"}
				description={data.search
					? `Ningún cliente coincide con "${data.search}".`
					: "Los clientes aparecen aquí cuando el asistente o tu equipo registra un pedido."}
			/>
		{:else}
			<DataTable data={data.customers} {columns} keyField="id" onRowClick={(c) => goto(`${businessPath()}/clientes/${c.id}`)} />
			{#if data.customers.length === data.limit}
				<p class="border-t border-border-subtle px-4 py-3 text-sm text-fg-muted">
					Se muestran los {data.limit} más recientes. Busca para encontrar a otro.
				</p>
			{/if}
		{/if}
	</div>
</Page>

<Modal bind:open title="Nuevo cliente" onClose={() => (open = false)}>
	<CustomerFields bind:form {errors} disabled={isSaving} />

	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)} disabled={isSaving}>Cancelar</Button>
		<Button onclick={create} disabled={isSaving}>{isSaving ? "Guardando…" : "Crear cliente"}</Button>
	{/snippet}
</Modal>

{#snippet nameCell(c: CustomerSummary)}
	<a href="{businessPath()}/clientes/{c.id}" class="text-fg hover:underline">{c.name}</a>
	{#if c.email}
		<div class="text-sm text-fg-muted">{c.email}</div>
	{/if}
{/snippet}

{#snippet phoneCell(c: CustomerSummary)}
	<span class="font-mono text-sm whitespace-nowrap text-fg-muted">{c.phone ? formatPhone(c.phone) : "–"}</span>
{/snippet}

{#snippet ordersCell(c: CustomerSummary)}
	<span class="tabular-nums">{c.order_count}</span>
{/snippet}

{#snippet spentCell(c: CustomerSummary)}
	<span class="whitespace-nowrap tabular-nums">S/ {formatCents(c.spent_cents)}</span>
{/snippet}
