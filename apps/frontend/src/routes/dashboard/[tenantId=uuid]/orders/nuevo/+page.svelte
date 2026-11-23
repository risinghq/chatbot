<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import type {
  Customer,
  CustomerAddress,
  OrderDetail,
  StockRow,
} from "@vendeya/types";
import { goto } from "$app/navigation";
import CustomerPicker from "#lib/components/orders/customer-picker.svelte";
import ProductPicker from "#lib/components/orders/product-picker.svelte";
import NeedsTenant from "#lib/components/shared/needs-tenant.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import Select from "#lib/components/ui/select.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { formatCents } from "#lib/utils/money.js";
import {
  addVariant,
  draftProblems,
  draftTotals,
  emptyDraft,
  orderBody,
  withAvailability,
} from "#lib/utils/order-draft.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

/** The page edits its own copy of what the loader read. */
function loaded() {
  return {
    draft: {
      ...emptyDraft(data.customer?.id ?? null),
      locationId:
        data.locations.length > 1 ? (data.locations[0]?.id ?? "") : "",
    },
    customer: data.customer,
    addresses: data.addresses,
    stock: data.stock,
  };
}

const start = loaded();
let draft = $state(start.draft);
let customer = $state<Customer | null>(start.customer);
let addresses = $state<CustomerAddress[]>(start.addresses);
let stock = $state<StockRow[]>(start.stock);
let savedAddressId = $state("");
let isSaving = $state(false);

const totals = $derived(draftTotals(draft, data.zones));
const problems = $derived(draftProblems(draft, data.zones));

const deliveryItems = [
  { value: "pickup", label: "Recojo en tienda" },
  { value: "ship", label: "Envío a domicilio" },
];
const zoneItems = $derived([
  { value: "", label: "Sin zona: costo a mano" },
  ...data.zones.map((z) => ({
    value: z.id,
    label: `${z.name} · ${formatCents(z.fee_cents)}`,
  })),
]);
const locationItems = $derived(
  data.locations.map((l) => ({ value: l.id, label: l.name })),
);
const addressItems = $derived(
  addresses.map((a) => ({
    value: a.id,
    label: [a.line, a.district].filter(Boolean).join(", "),
  })),
);

async function selectCustomer(next: Customer | null) {
  customer = next;
  draft.customerId = next?.id ?? null;
  addresses = [];
  savedAddressId = "";
  if (!next) return;
  try {
    addresses = await fetchApi<CustomerAddress[]>(
      `/api/customers/${next.id}/addresses`,
    );
  } catch {
    toast.error("No se pudieron leer sus direcciones");
  }
}

function useAddress(id: string) {
  const saved = addresses.find((a) => a.id === id);
  if (!saved) return;
  draft.address = {
    line: saved.line,
    district: saved.district ?? "",
    city: saved.city ?? "",
    reference: saved.reference ?? "",
  };
}

async function changeLocation(id: string) {
  try {
    stock = await fetchApi<StockRow[]>(
      `/api/stock?location_id=${encodeURIComponent(id)}`,
    );
    draft.lines = withAvailability(draft.lines, stock);
  } catch {
    toast.error("No se pudo leer el stock de ese local");
  }
}

function removeLine(variantId: string) {
  draft.lines = draft.lines.filter((l) => l.variantId !== variantId);
}

async function submit() {
  if (problems.length > 0) return;
  isSaving = true;
  try {
    const order = await fetchApi<OrderDetail>("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderBody(draft, data.zones)),
    });
    toast.success("Pedido registrado");
    await goto(`${businessPath()}/orders/${order.id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      toast.error("No hay stock suficiente. Revisa las cantidades.");
    else if (error instanceof ApiError && error.status === 400)
      toast.error(error.message);
    else toast.error("No se pudo registrar el pedido");
  } finally {
    isSaving = false;
  }
}
</script>

<PageTitle title="Nuevo pedido" />

<Page>
	<a href="{businessPath()}/orders" class="mb-3 inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
		<Icon name="arrow" class="size-3.5 rotate-180" />
		Pedidos
	</a>
	<PageHeader title="Nuevo pedido" subtitle="Registra una venta tomada por teléfono, en tienda o por chat." />

	{#if !auth.activeTenantId}
		<NeedsTenant />
	{:else if !auth.canTakeOrders}
		<div class="rounded-md border border-border bg-surface">
			<EmptyState title="Sin permiso" description="Tu rol no puede registrar pedidos. Pídeselo a quien administra el negocio." />
		</div>
	{:else}
		<div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
			<div class="flex flex-col gap-4 lg:col-span-2">
				<SectionShell title="Cliente">
					<div class="p-4">
						<CustomerPicker {customer} onselect={selectCustomer} />
					</div>
				</SectionShell>

				<SectionShell title="Productos">
					{#snippet action()}
						{#if locationItems.length > 1}
							<Select
								id="order-location"
								bind:value={draft.locationId}
								items={locationItems}
								class="w-44"
								onchange={(e) => changeLocation(e.currentTarget.value)}
							/>
						{/if}
					{/snippet}
					<div class="p-4">
						<ProductPicker rows={stock} onadd={(row) => (draft.lines = addVariant(draft.lines, row))} />
					</div>
					{#if draft.lines.length > 0}
						<ul class="divide-y divide-border-subtle border-t border-border-subtle">
							{#each draft.lines as line (line.variantId)}
								<li class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[1fr_5rem_7rem_auto]">
									<div class="col-span-2 min-w-0 sm:col-span-1">
										<div class="truncate text-fg">{line.label}</div>
										<div class="text-sm text-fg-muted">
											<span class="font-mono">{line.sku}</span> · {line.available} disponibles
										</div>
									</div>
									<label class="flex items-center gap-2 text-sm text-fg-muted sm:block">
										<span class="sm:sr-only">Cantidad</span>
										<Input type="number" inputmode="numeric" bind:value={line.quantity} class="w-20 text-right tabular-nums" />
									</label>
									<label class="flex items-center gap-2 text-sm text-fg-muted sm:block">
										<span class="sm:sr-only">Precio S/</span>
										<Input inputmode="decimal" bind:value={line.price} class="w-28 text-right tabular-nums" />
									</label>
									<button
										type="button"
										class="inline-flex size-7 items-center justify-center justify-self-end rounded-sm text-fg-muted transition-colors hover:bg-hover hover:text-danger-text pointer-coarse:size-11"
										aria-label="Quitar {line.label}"
										onclick={() => removeLine(line.variantId)}
									>
										<Icon name="trash" class="size-4" />
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</SectionShell>

				<SectionShell title="Entrega">
					<div class="p-4 pb-0">
						<FormField label="Cómo lo recibe" for="order-delivery">
							<Select id="order-delivery" bind:value={draft.delivery} items={deliveryItems} />
						</FormField>
						{#if draft.delivery === "ship"}
							<div class="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
								<FormField label="Zona" for="order-zone">
									<Select id="order-zone" bind:value={draft.zoneId} items={zoneItems} />
								</FormField>
								{#if !draft.zoneId}
									<FormField label="Costo de envío (S/)" for="order-fee">
										<Input id="order-fee" inputmode="decimal" bind:value={draft.fee} />
									</FormField>
								{/if}
							</div>
							{#if addressItems.length > 0}
								<FormField label="Dirección guardada" for="order-saved-address">
									<Select
										id="order-saved-address"
										bind:value={savedAddressId}
										items={addressItems}
										placeholder="Elegir una de sus direcciones"
										onchange={(e) => useAddress(e.currentTarget.value)}
									/>
								</FormField>
							{/if}
							<FormField label="Dirección" for="order-address">
								<Input id="order-address" bind:value={draft.address.line} autocomplete="street-address" />
							</FormField>
							<div class="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
								<FormField label="Distrito" for="order-district">
									<Input id="order-district" bind:value={draft.address.district} />
								</FormField>
								<FormField label="Ciudad" for="order-city">
									<Input id="order-city" bind:value={draft.address.city} />
								</FormField>
							</div>
							<FormField label="Referencia" for="order-reference">
								<Input id="order-reference" bind:value={draft.address.reference} />
							</FormField>
						{/if}
					</div>
				</SectionShell>

				<SectionShell title="Notas">
					<div class="p-4">
						<Textarea id="order-notes" bind:value={draft.notes} rows={3} placeholder="Lo que el equipo debe saber del pedido" />
					</div>
				</SectionShell>
			</div>

			<aside class="rounded-md border border-border bg-surface p-4 lg:sticky lg:top-6">
				<h2 class="text-md text-fg">Resumen</h2>
				<dl class="mt-3 grid grid-cols-[1fr_auto] gap-y-1.5 text-base">
					<dt class="text-fg-muted">Subtotal</dt>
					<dd class="text-right tabular-nums">{totals.subtotal === null ? "–" : formatCents(totals.subtotal)}</dd>
					<dt class="text-fg-muted">Envío</dt>
					<dd class="text-right tabular-nums">{totals.fee === null ? "–" : formatCents(totals.fee)}</dd>
					<dt class="border-t border-border-subtle pt-1.5 text-fg">Total</dt>
					<dd class="border-t border-border-subtle pt-1.5 text-right text-fg tabular-nums">
						{totals.total === null ? "–" : formatCents(totals.total)}
					</dd>
				</dl>
				{#if problems.length > 0}
					<ul class="mt-4 list-disc space-y-1 pl-5 text-sm text-fg-muted">
						{#each problems as problem (problem)}
							<li>{problem}</li>
						{/each}
					</ul>
				{/if}
				<Button class="mt-4 w-full" onclick={submit} disabled={problems.length > 0 || isSaving}>
					{isSaving ? "Registrando…" : "Registrar pedido"}
				</Button>
			</aside>
		</div>
	{/if}
</Page>
