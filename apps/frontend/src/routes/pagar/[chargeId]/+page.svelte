<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { page } from "$app/state";
import Button from "#lib/components/ui/button.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import { fetchApi } from "#lib/utils/api.js";
import { formatCents } from "#lib/utils/money.js";

type PayPage = {
  business_name: string;
  order_number: number;
  amount_cents: number;
  status: "pending" | "completed" | "expired" | "failed";
  expires_at: number;
  checkout: { public_key: string; token: string; script: string } | null;
};

/** TAYPI's checkout.js v2, as its documentation describes it. */
type TaypiCheckout = {
  publicKey: string;
  open(options: {
    sessionToken: string;
    onSuccess?: () => void;
    onExpired?: () => void;
    onClose?: () => void;
    onError?: (error: unknown) => void;
  }): void;
};

/** Checks after a payment until the webhook or TAYPI's list confirms it. */
const CHECK_EVERY_MS = 4000;
const CHECKS_AFTER_PAYMENT = 15;

const chargeId = page.params.chargeId ?? "";
const api = `/api/pay/${encodeURIComponent(chargeId)}`;
let pay = $state<PayPage | null>(null);
let missing = $state(false);
let opening = $state(false);
let confirming = $state(false);
let scriptError = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;

onMount(async () => {
  try {
    pay = await fetchApi<PayPage>(api);
  } catch {
    missing = true;
  }
});

onDestroy(() => clearTimeout(timer));

function loadScript(src: string): Promise<TaypiCheckout> {
  const loaded = (window as { Taypi?: TaypiCheckout }).Taypi;
  if (loaded) return Promise.resolve(loaded);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      const taypi = (window as { Taypi?: TaypiCheckout }).Taypi;
      if (taypi) resolve(taypi);
      else reject(new Error("checkout.js loaded without Taypi"));
    };
    script.onerror = () => reject(new Error("checkout.js did not load"));
    document.head.appendChild(script);
  });
}

async function check(left: number) {
  try {
    pay = await fetchApi<PayPage>(`${api}/check`, { method: "POST" });
  } catch {
    // A failed check is retried below; the webhook may still settle it.
  }
  if (pay?.status === "pending" && left > 0) {
    timer = setTimeout(() => check(left - 1), CHECK_EVERY_MS);
  } else {
    confirming = false;
  }
}

async function openCheckout() {
  if (!pay?.checkout) return;
  opening = true;
  scriptError = false;
  try {
    const taypi = await loadScript(pay.checkout.script);
    taypi.publicKey = pay.checkout.public_key;
    taypi.open({
      sessionToken: pay.checkout.token,
      onSuccess: () => {
        confirming = true;
        void check(CHECKS_AFTER_PAYMENT);
      },
      onExpired: async () => {
        pay = await fetchApi<PayPage>(api).catch(() => pay);
      },
      onError: () => {
        scriptError = true;
      },
    });
  } catch {
    scriptError = true;
  } finally {
    opening = false;
  }
}

const expiresAt = $derived(
  pay
    ? new Date(pay.expires_at).toLocaleTimeString("es-PE", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Lima",
      })
    : "",
);
</script>

<PageTitle title="Pagar pedido" />

<div class="flex min-h-dvh flex-col items-center justify-center bg-canvas p-4">
	<div class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
		{#if missing}
			<h1 class="text-lg font-medium text-fg">Este link de pago no existe</h1>
			<p class="mt-1 text-base text-fg-muted">Revisa el link o pide uno nuevo a la tienda.</p>
		{:else if !pay}
			<div class="h-32 animate-pulse rounded-sm bg-sunken" aria-busy="true"></div>
		{:else}
			<p class="text-sm text-fg-muted">{pay.business_name} · Pedido #{pay.order_number}</p>
			<p class="mt-1 text-3xl font-semibold tabular-nums text-fg">{formatCents(pay.amount_cents)}</p>

			{#if pay.status === "completed"}
				<p role="status" class="mt-6 rounded-sm bg-success-soft px-3 py-2 text-base text-success-text">
					¡Pago recibido! La tienda ya lo ve en tu pedido.
				</p>
			{:else if pay.status === "expired" || pay.status === "failed"}
				<p class="mt-6 text-base text-fg-muted">
					Este link {pay.status === "expired" ? "venció" : "no se pudo pagar"}. Escríbele a la tienda para que te envíe uno nuevo.
				</p>
			{:else if confirming}
				<p role="status" class="mt-6 text-base text-fg-muted" aria-busy="true">
					Confirmando tu pago con tu banco…
				</p>
			{:else}
				<p class="mt-2 text-sm text-fg-muted">
					Paga con Yape, Plin o la app de tu banco. El link vence a las {expiresAt}.
				</p>
				<Button class="mt-6 w-full" onclick={openCheckout} disabled={opening}>
					{opening ? "Abriendo…" : "Pagar con QR"}
				</Button>
				{#if scriptError}
					<p role="alert" class="mt-4 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger-text">
						No se pudo abrir el pago. Inténtalo otra vez en un momento.
					</p>
				{/if}
			{/if}
			<p class="mt-6 text-xs text-fg-subtle">Pago seguro con TAYPI.</p>
		{/if}
	</div>
</div>
