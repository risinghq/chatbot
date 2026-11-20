<script lang="ts">
import type { Customer, CustomerSummary } from "@vendeya/types";
import CustomerFields from "#lib/components/orders/customer-fields.svelte";
import Button from "#lib/components/ui/button.svelte";
import Input from "#lib/components/ui/input.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import {
  customerBody,
  customerForm,
  customerFormProblems,
} from "#lib/utils/customer-form.js";
import { formatPhone } from "#lib/utils/formatters.js";

type Props = {
  customer: Customer | null;
  onselect: (customer: Customer | null) => void;
};

let { customer, onselect }: Props = $props();

/** Waits for a pause in typing so each keystroke does not query. */
const SEARCH_DELAY_MS = 250;

let query = $state("");
let results = $state<CustomerSummary[]>([]);
let searched = $state(false);
let open = $state(false);
let form = $state(customerForm());
let errors = $state<ReturnType<typeof customerFormProblems>>({});
let isSaving = $state(false);

$effect(() => {
  const q = query.trim();
  if (!q) {
    results = [];
    searched = false;
    return;
  }
  let current = true;
  const timer = setTimeout(async () => {
    const params = new URLSearchParams({ search: q, limit: "8" });
    try {
      const found = await fetchApi<CustomerSummary[]>(
        `/api/customers?${params}`,
      );
      if (current) {
        results = found;
        searched = true;
      }
    } catch {
      if (current) toast.error("No se pudo buscar clientes");
    }
  }, SEARCH_DELAY_MS);
  return () => {
    current = false;
    clearTimeout(timer);
  };
});

function choose(next: Customer | null) {
  query = "";
  onselect(next);
}

function openCreate() {
  // What was searched starts the form: digits are a phone, anything else a name.
  const typed = query.trim();
  const isPhone = /\d/.test(typed);
  form = {
    ...customerForm(),
    name: isPhone ? "" : typed,
    phone: isPhone ? typed : "",
  };
  errors = {};
  open = true;
}

async function create() {
  errors = customerFormProblems(form);
  if (Object.keys(errors).length > 0) return;
  isSaving = true;
  try {
    const created = await fetchApi<Customer>("/api/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(customerBody(form)),
    });
    open = false;
    toast.success("Cliente creado");
    choose(created);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      errors = { phone: "Otro cliente ya tiene este teléfono" };
    else toast.error("No se pudo crear el cliente");
  } finally {
    isSaving = false;
  }
}
</script>

{#if customer}
	<div class="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2">
		<div class="min-w-0">
			<div class="truncate text-fg">{customer.name}</div>
			{#if customer.phone}
				<div class="font-mono text-sm text-fg-muted">{formatPhone(customer.phone)}</div>
			{/if}
		</div>
		<Button size="sm" variant="secondary" onclick={() => choose(null)}>Cambiar</Button>
	</div>
{:else}
	<div class="flex gap-2">
		<Input id="order-customer" bind:value={query} placeholder="Buscar por nombre o teléfono" autocomplete="off" />
		<Button variant="secondary" onclick={openCreate}>Cliente nuevo</Button>
	</div>
	{#if results.length > 0}
		<ul class="mt-2 divide-y divide-border-subtle rounded-md border border-border-subtle">
			{#each results as found (found.id)}
				<li>
					<button
						type="button"
						class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-hover pointer-coarse:min-h-11"
						onclick={() => choose(found)}
					>
						<span class="truncate text-fg">{found.name}</span>
						<span class="font-mono text-sm whitespace-nowrap text-fg-muted">
							{found.phone ? formatPhone(found.phone) : ""}
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{:else if searched}
		<p class="mt-2 text-sm text-fg-muted">Ningún cliente coincide. Créalo con "Cliente nuevo".</p>
	{/if}
{/if}

<Modal bind:open title="Cliente nuevo" onClose={() => (open = false)}>
	<CustomerFields bind:form {errors} disabled={isSaving} />

	{#snippet footer()}
		<Button variant="secondary" onclick={() => (open = false)} disabled={isSaving}>Cancelar</Button>
		<Button onclick={create} disabled={isSaving}>{isSaving ? "Guardando…" : "Crear cliente"}</Button>
	{/snippet}
</Modal>
