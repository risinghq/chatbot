<script lang="ts">
import type { Customer, OrderSummary } from "@vendeya/types";
import { goto, invalidateAll } from "$app/navigation";
import CustomerAddresses from "#lib/components/orders/customer-addresses.svelte";
import CustomerFields from "#lib/components/orders/customer-fields.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import {
  customerBody,
  customerForm,
  customerFormProblems,
} from "#lib/utils/customer-form.js";
import { formatDateTime, formatPhone } from "#lib/utils/formatters.js";
import { formatCents } from "#lib/utils/money.js";
import {
  orderLabel,
  orderStatusLabel,
  orderStatusVariant,
  paymentStateLabels,
  paymentStateVariant,
} from "#lib/utils/order-status.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let form = $state(customerForm());
let errors = $state<ReturnType<typeof customerFormProblems>>({});
let isSaving = $state(false);

// A save or another customer reloads `data`; the form follows it.
$effect.pre(() => {
  form = customerForm(data.customer ?? undefined);
  errors = {};
});

const canEdit = $derived(auth.canTakeOrders);

const orderColumns = [
  { header: "Pedido", cell: numberCell },
  { header: "Total", align: "right" as const, cell: totalCell },
  { header: "Pago", cell: paymentCell },
  { header: "Estado", cell: statusCell },
  { header: "Fecha", cell: dateCell },
];

async function save(customer: Customer) {
  errors = customerFormProblems(form);
  if (Object.keys(errors).length > 0) return;
  isSaving = true;
  try {
    await fetchApi<Customer>(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(customerBody(form)),
    });
    await invalidateAll();
    toast.success("Cliente actualizado");
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      errors = { phone: "Otro cliente ya tiene este teléfono" };
    else toast.error("No se pudo guardar el cliente");
  } finally {
    isSaving = false;
  }
}

async function remove(customer: Customer) {
  if (!confirm(`¿Eliminar a ${customer.name} y sus direcciones?`)) return;
  isSaving = true;
  try {
    await fetchApi(`/api/customers/${customer.id}`, { method: "DELETE" });
    toast.success("Cliente eliminado");
    await goto("/dashboard/clientes");
  } catch (error) {
    toast.error(
      error instanceof ApiError && error.status === 409
        ? "Tiene pedidos, así que se conserva"
        : "No se pudo eliminar el cliente",
    );
  } finally {
    isSaving = false;
  }
}
</script>

<PageTitle title={data.customer?.name ?? "Cliente"} />

<Page>
	<a href="/dashboard/clientes" class="mb-3 inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
		<Icon name="arrow" class="size-3.5 rotate-180" />
		Clientes
	</a>

	{#if !data.customer}
		<div class="rounded-md border border-border bg-surface">
			<EmptyState title="Cliente no encontrado" description="Puede que lo hayan eliminado o que el enlace esté mal.">
				{#snippet action()}
					<Button href="/dashboard/clientes" variant="secondary">Volver a clientes</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		{@const customer = data.customer}
		<header class="mb-6 flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h1 class="text-xl text-fg">{customer.name}</h1>
				{#if customer.phone}
					<p class="mt-1 font-mono text-base text-fg-muted">{formatPhone(customer.phone)}</p>
				{/if}
			</div>
			{#if auth.canDeleteCustomers && data.orders.length === 0}
				<Button variant="danger" size="sm" onclick={() => remove(customer)} disabled={isSaving}>Eliminar cliente</Button>
			{/if}
		</header>

		<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
			<div class="flex flex-col gap-4 lg:col-span-2">
				<SectionShell title="Pedidos" description="Lo que compró, del más reciente al más antiguo.">
					{#if data.orders.length > 0}
						<DataTable data={data.orders} columns={orderColumns} keyField="id" onRowClick={(o) => goto(`/dashboard/orders/${o.id}`)} />
					{:else}
						<p class="px-4 py-3 text-sm text-fg-muted">Todavía no tiene pedidos.</p>
					{/if}
				</SectionShell>

				<CustomerAddresses customerId={customer.id} addresses={data.addresses} {canEdit} />
			</div>

			<SectionShell title="Datos">
				<form
					class="p-4"
					onsubmit={(event) => {
						event.preventDefault();
						void save(customer);
					}}
				>
					<CustomerFields bind:form {errors} disabled={!canEdit || isSaving} />
					{#if canEdit}
						<Button type="submit" disabled={isSaving}>{isSaving ? "Guardando…" : "Guardar"}</Button>
					{/if}
				</form>
			</SectionShell>
		</div>
	{/if}
</Page>

{#snippet numberCell(o: OrderSummary)}
	<a href="/dashboard/orders/{o.id}" class="font-mono whitespace-nowrap text-fg hover:underline">{orderLabel(o.number)}</a>
{/snippet}

{#snippet totalCell(o: OrderSummary)}
	<span class="whitespace-nowrap tabular-nums">S/ {formatCents(o.total_cents)}</span>
{/snippet}

{#snippet paymentCell(o: OrderSummary)}
	<Badge variant={paymentStateVariant(o.payment_state)}>{paymentStateLabels[o.payment_state]}</Badge>
{/snippet}

{#snippet statusCell(o: OrderSummary)}
	<Badge variant={orderStatusVariant(o.status)}>{orderStatusLabel(o.status)}</Badge>
{/snippet}

{#snippet dateCell(o: OrderSummary)}
	<span class="text-sm text-fg-muted tabular-nums">{formatDateTime(o.created_at)}</span>
{/snippet}
