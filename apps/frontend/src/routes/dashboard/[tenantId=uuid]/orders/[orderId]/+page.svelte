<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import { invalidateAll } from "$app/navigation";
import {
  ORDER_TRANSITIONS,
  type OrderDetail,
  type OrderStatus,
} from "@vendeya/types";
import { fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import { auth } from "#lib/state/auth.svelte.js";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import { formatPhone, formatDateTime } from "#lib/utils/formatters.js";
import { formatCents, parseCents } from "#lib/utils/money.js";
import {
  orderLabel,
  orderStatusLabel,
  orderStatusVariant,
  paymentStateLabels,
  paymentStateVariant,
  paymentStatusLabels,
  paymentStatusVariant,
  transitionLabel,
} from "#lib/utils/order-status.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let busy = $state(false);
let paymentAmount = $state("");
let paymentMethod = $state("");
let paymentReference = $state("");

const methodItems = $derived(
  data.methods.map((m) => ({ value: m.id, label: m.name })),
);

/** The moves the caller's role may make from the order's status. */
function movesFor(order: OrderDetail): OrderStatus[] {
  return ORDER_TRANSITIONS[order.status].filter((to) =>
    to === "cancelled" ? auth.canDecideMoney : auth.canFulfilOrders,
  );
}

async function act(path: string, body: object, done: string) {
  if (!data.order) return false;
  busy = true;
  try {
    await fetchApi(`/api/orders/${data.order.id}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast.success(done);
    await invalidateAll();
    return true;
  } catch (error) {
    toast.error((error as Error).message);
    return false;
  } finally {
    busy = false;
  }
}

async function move(to: OrderStatus) {
  if (
    to === "cancelled" &&
    !confirm("¿Cancelar el pedido? Las unidades reservadas vuelven al stock.")
  ) {
    return;
  }
  await act(
    "/transition",
    { status: to },
    `Pedido ${orderStatusLabel(to).toLowerCase()}`,
  );
}

async function addPayment(event: SubmitEvent) {
  event.preventDefault();
  const amount = parseCents(paymentAmount);
  if (amount === null || amount <= 0) {
    toast.error("Ingresa un monto válido");
    return;
  }
  if (!paymentMethod) {
    toast.error("Elige un método de pago");
    return;
  }
  const added = await act(
    "/payments",
    {
      method_id: paymentMethod,
      amount_cents: amount,
      reference: paymentReference.trim() || null,
    },
    "Pago registrado",
  );
  if (added) {
    paymentAmount = "";
    paymentReference = "";
  }
}

function decide(paymentId: string, action: "confirm" | "reject") {
  return act(
    `/payments/${paymentId}/${action}`,
    {},
    action === "confirm" ? "Pago confirmado" : "Pago rechazado",
  );
}
</script>

<PageTitle title={data.order ? `Pedido ${orderLabel(data.order.number)}` : "Pedido"} />

{#snippet heading(title: string)}
	<h2 class="mb-3 text-md font-medium text-fg">{title}</h2>
{/snippet}

{#snippet field(label: string, value: string, mono = false)}
	<div>
		<dt class="text-sm text-fg-muted">{label}</dt>
		<dd class="mt-0.5 text-fg tabular-nums {mono ? 'font-mono' : ''}">{value}</dd>
	</div>
{/snippet}

{#snippet sum(label: string, cents: number, strong = false)}
	<div class="flex items-baseline justify-between">
		<span class={strong ? "text-fg" : "text-fg-muted"}>{label}</span>
		<span class="tabular-nums {strong ? 'text-md font-medium text-fg' : 'text-fg'}">S/ {formatCents(cents)}</span>
	</div>
{/snippet}

<Page>
	<a href="{businessPath()}/orders" class="mb-3 inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
		<Icon name="arrow" class="size-3.5 rotate-180" />
		Pedidos
	</a>

	{#if !data.order}
		<div class="rounded-md border border-border bg-surface">
			<EmptyState title="Pedido no encontrado" description="Puede que lo hayan eliminado o que el enlace esté mal.">
				{#snippet action()}
					<Button href="{businessPath()}/orders" variant="secondary">Volver a pedidos</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		{@const order = data.order}
		{@const moves = movesFor(order)}
		{@const balance = order.total_cents - order.paid_cents}
		{@const canPay = auth.canTakeOrders && order.status !== "cancelled" && balance > 0}

		<header class="mb-6 flex flex-wrap items-start justify-between gap-3">
			<div class="min-w-0">
				<h1 class="font-mono text-xl text-fg">{orderLabel(order.number)}</h1>
				<a href="{businessPath()}/clientes/{order.customer.id}" class="mt-1 block text-base text-fg-muted hover:text-fg hover:underline">{order.customer.name}</a>
			</div>
			<div class="flex gap-2">
				<Badge variant={paymentStateVariant(order.payment_state)}>{paymentStateLabels[order.payment_state]}</Badge>
				<Badge variant={orderStatusVariant(order.status)}>{orderStatusLabel(order.status)}</Badge>
			</div>
		</header>

		<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
			<div class="flex flex-col gap-4 lg:col-span-2">
				<div class="divide-y divide-border-subtle rounded-md border border-border bg-surface">
					<section class="p-4">
						{@render heading("Productos")}
						<ul class="divide-y divide-border-subtle">
							{#each order.lines as line (line.id)}
								<li class="flex items-baseline justify-between gap-4 py-2 first:pt-0">
									<div class="min-w-0">
										<span class="text-fg">{line.name}</span>
										{#if line.sku}
											<span class="ml-2 font-mono text-sm text-fg-muted">{line.sku}</span>
										{/if}
									</div>
									<span class="whitespace-nowrap text-fg-muted tabular-nums">
										{line.quantity} × S/ {formatCents(line.unit_price_cents)}
									</span>
								</li>
							{/each}
						</ul>
						<div class="mt-3 flex flex-col gap-1 border-t border-border-subtle pt-3">
							{@render sum("Subtotal", order.subtotal_cents)}
							{#if order.delivery_fee_cents > 0}
								{@render sum("Envío", order.delivery_fee_cents)}
							{/if}
							{@render sum("Total", order.total_cents, true)}
						</div>
					</section>

					<section class="p-4">
						{@render heading("Entrega")}
						{#if order.shipment}
							{@const s = order.shipment}
							<dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
								{@render field("Dirección", [s.address_line, s.district, s.city].filter(Boolean).join(", "))}
								{@render field("Zona", s.zone_name ?? "—")}
								{@render field("Recibe", s.recipient_name)}
								{#if s.recipient_phone}
									{@render field("Teléfono", formatPhone(s.recipient_phone), true)}
								{/if}
								{#if s.reference}
									{@render field("Referencia", s.reference)}
								{/if}
								{#if s.carrier || s.tracking_code}
									{@render field("Transportista", [s.carrier, s.tracking_code].filter(Boolean).join(" · "))}
								{/if}
							</dl>
						{:else}
							<p class="text-fg-muted">Recojo en tienda.</p>
						{/if}
					</section>
				</div>

				<section class="rounded-md border border-border bg-surface p-4">
					<div class="mb-3 flex items-baseline justify-between">
						<h2 class="text-md font-medium text-fg">Pagos</h2>
						<span class="text-sm text-fg-muted tabular-nums">
							Pagado S/ {formatCents(order.paid_cents)} de S/ {formatCents(order.total_cents)}
						</span>
					</div>

					{#if order.payments.length === 0}
						<p class="text-fg-muted">Aún no hay pagos registrados.</p>
					{:else}
						<ul class="divide-y divide-border-subtle">
							{#each order.payments as payment (payment.id)}
								<li class="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0">
									<div class="min-w-0">
										<div class="text-fg tabular-nums">S/ {formatCents(payment.amount_cents)} · {payment.method_name}</div>
										<div class="text-sm text-fg-muted">
											{formatDateTime(payment.created_at)}{payment.reference ? ` · ${payment.reference}` : ""}
										</div>
									</div>
									<div class="flex items-center gap-2">
										{#if payment.status === "pending" && auth.canDecideMoney && order.status !== "cancelled"}
											<Button size="sm" onclick={() => decide(payment.id, "confirm")} disabled={busy}>Confirmar</Button>
											<Button size="sm" variant="ghost" onclick={() => decide(payment.id, "reject")} disabled={busy}>Rechazar</Button>
										{:else}
											<Badge variant={paymentStatusVariant(payment.status)}>{paymentStatusLabels[payment.status]}</Badge>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					{/if}

					{#if canPay}
						<form class="mt-4 grid grid-cols-1 items-end gap-x-3 border-t border-border-subtle pt-4 sm:grid-cols-[1fr_1fr_1fr_auto]" onsubmit={addPayment}>
							<FormField label="Monto" for="payment-amount" class="mb-3! sm:mb-0!">
								<Input id="payment-amount" bind:value={paymentAmount} inputmode="decimal" placeholder={formatCents(balance)} />
							</FormField>
							<FormField label="Método" for="payment-method" class="mb-3! sm:mb-0!">
								{#if methodItems.length > 0}
									<Select id="payment-method" bind:value={paymentMethod} items={methodItems} placeholder="Elegir" />
								{:else}
									{#if auth.isAdmin}
										<a href="{businessPath()}/admin/orders" class="block py-1.5 text-sm text-accent-text hover:underline">Agrega un método de pago</a>
									{:else}
										<span class="block py-1.5 text-sm text-fg-muted">Un administrador debe agregar un método de pago</span>
									{/if}
								{/if}
							</FormField>
							<FormField label="Operación" for="payment-reference" class="mb-3! sm:mb-0!">
								<Input id="payment-reference" bind:value={paymentReference} placeholder="Opcional" />
							</FormField>
							<Button type="submit" size="sm" disabled={busy || methodItems.length === 0}>Registrar pago</Button>
						</form>
					{/if}
				</section>
			</div>

			<div class="flex flex-col gap-4">
				{#if moves.length > 0}
					<section class="rounded-md border border-border bg-surface p-4">
						{@render heading("Siguiente paso")}
						<div class="flex flex-col gap-2">
							{#each moves as to (to)}
								<Button
									variant={to === "cancelled" ? "ghost" : "primary"}
									onclick={() => move(to)}
									disabled={busy}
								>
									{transitionLabel(order.status, to)}
								</Button>
							{/each}
						</div>
					</section>
				{/if}

				<section class="rounded-md border border-border bg-surface p-4">
					{@render heading("Cliente")}
					<dl class="grid grid-cols-1 gap-3">
						{@render field("Nombre", order.customer.name)}
						{#if order.customer.phone}
							{@render field("Teléfono", formatPhone(order.customer.phone), true)}
						{/if}
						{#if order.customer.document_number}
							{@render field(
								(order.customer.document_type ?? "Documento").toUpperCase(),
								order.customer.document_number,
								true,
							)}
						{/if}
						{#if order.customer.phone && order.channel_account_id}
							<div>
								<a
									href="{businessPath()}/conversations/{order.customer.phone}?channel={order.channel_account_id}"
									class="text-accent-text hover:underline"
								>
									Abrir conversación
								</a>
							</div>
						{/if}
					</dl>
				</section>

				<section class="rounded-md border border-border bg-surface p-4">
					{@render heading("Historial")}
					<dl class="grid grid-cols-1 gap-3">
						{@render field("Creado", formatDateTime(order.created_at))}
						{@render field(
							"Registrado por",
							order.source === "assistant" ? "Asistente" : (order.created_by_name ?? "Usuario eliminado"),
						)}
						{@render field("Última actualización", formatDateTime(order.updated_at))}
						{#if order.notes}
							{@render field("Notas", order.notes)}
						{/if}
					</dl>
				</section>
			</div>
		</div>
	{/if}
</Page>
