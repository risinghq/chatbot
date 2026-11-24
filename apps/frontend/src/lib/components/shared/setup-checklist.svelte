<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import { onMount } from "svelte";
import Button from "#lib/components/ui/button.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import { fetchApi } from "#lib/utils/api.js";

type SetupStatus = {
  openai_configured: boolean;
  has_catalog: boolean;
  has_stock: boolean;
  has_payment_methods: boolean;
  tried_simulator: boolean;
  whatsapp_configured: boolean;
  calidda_configured: boolean;
  complete: boolean;
};

let status = $state<SetupStatus | null>(null);
let loading = $state(true);

// The order is the path a new business takes: the assistant needs a key to
// think, a catalog to quote, stock to reserve and a way to be paid; the
// simulator proves them before a customer sees them, and only then does a
// number go live.
const steps = $derived(
  status
    ? [
        {
          done: status.openai_configured,
          label: "Clave de OpenAI",
          hint: "El asistente la usa para entender y responder. Se crea en platform.openai.com y OpenAI cobra por uso.",
          action: "Agregar clave",
          href: businessPath("/admin/settings"),
        },
        {
          done: status.has_catalog,
          label: "Catálogo publicado",
          hint: "Al menos un producto activo con precio. Es lo que el asistente cotiza.",
          action: "Abrir catálogo",
          href: businessPath("/catalog"),
        },
        {
          done: status.has_stock,
          label: "Stock disponible",
          hint: "Sin stock, el asistente no puede tomar pedidos.",
          action: "Registrar stock",
          href: businessPath("/inventario"),
        },
        {
          done: status.has_payment_methods,
          label: "Métodos de pago",
          hint: "Cómo te pagan: Yape, transferencia, efectivo. El asistente los ofrece y cada pedido registra el suyo.",
          action: "Agregar método",
          href: businessPath("/admin/orders"),
        },
        {
          done: status.tried_simulator,
          label: "Prueba el asistente",
          hint: "Conversa con él como un cliente. No envía nada a nadie.",
          action: "Probar",
          href: businessPath("/asistente/probar"),
        },
        {
          done: status.whatsapp_configured,
          label: "Número de WhatsApp",
          hint: "El equipo de VendeYa conecta tu número de WhatsApp Business a tu negocio.",
          action: "Ver números",
          href: businessPath("/admin/channels"),
        },
      ]
    : [],
);

const doneCount = $derived(steps.filter((s) => s.done).length);
const next = $derived(steps.find((s) => !s.done));

async function load() {
  loading = true;
  try {
    status = await fetchApi<SetupStatus>("/api/admin/setup-status");
  } catch {
    status = null;
  } finally {
    loading = false;
  }
}

onMount(load);
</script>

{#if !loading && status && !status.complete}
	<section class="rounded-md border border-border bg-surface">
		<header class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
			<h2 class="text-md text-fg">Pon a vender tu negocio</h2>
			<span class="text-sm text-fg-muted tabular-nums">{doneCount} de {steps.length} listos</span>
		</header>
		<ol class="divide-y divide-border-subtle">
			{#each steps as step, i (step.label)}
				{@const current = step === next}
				<li class="flex items-center gap-3 px-4 py-2.5 {current ? 'bg-sunken' : ''}">
					<span
						class="flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums {step.done
							? 'bg-success text-on-solid'
							: current
								? 'bg-accent text-on-solid'
								: 'border border-border-strong text-fg-muted'}"
					>
						{#if step.done}<Icon name="check" class="size-3" />{:else}{i + 1}{/if}
					</span>
					<span class="min-w-0 flex-1">
						<span class="block text-base {step.done ? 'text-fg-muted line-through' : 'text-fg'}">
							{step.label}
						</span>
						{#if current}
							<span class="block text-sm text-fg-muted">{step.hint}</span>
						{/if}
					</span>
					{#if current}
						<Button href={step.href} size="sm">{step.action}</Button>
					{:else if !step.done}
						<Button href={step.href} size="sm" variant="ghost">{step.action}</Button>
					{/if}
				</li>
			{/each}
		</ol>
		<footer class="space-y-1 border-t border-border-subtle px-4 py-2.5 text-sm text-fg-muted">
			<p>
				Opcional: invita a quien atiende las conversaciones que el asistente deriva en
				<a href={businessPath("/admin/users")} class="text-fg underline underline-offset-2">Usuarios</a>.
			</p>
			{#if !status.calidda_configured}
				<p>
					Opcional: si vendes con crédito Cálidda, agrega tu usuario en
					<a href={businessPath("/admin/settings")} class="text-fg underline underline-offset-2">Configuración</a>.
				</p>
			{/if}
		</footer>
	</section>
{/if}
