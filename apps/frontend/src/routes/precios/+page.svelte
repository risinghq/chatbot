<script lang="ts">
import Button from "#lib/components/ui/button.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import SiteShell from "#lib/components/marketing/site-shell.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import { SUPPORT } from "#lib/utils/support.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

type Feature = { text: string; soon?: boolean };
type Plan = {
  name: string;
  price: number;
  blurb: string;
  features: Feature[];
  recommended?: boolean;
};

const plans: Plan[] = [
  {
    name: "Emprende",
    price: 99,
    blurb: "Para empezar a vender por WhatsApp.",
    features: [
      { text: "1 número de WhatsApp" },
      { text: "Hasta 300 productos" },
      { text: "2 usuarios del equipo" },
      { text: "Asistente, pedidos y stock" },
      { text: "Links de pago TAYPI" },
      { text: "Importa tu catálogo desde Excel" },
    ],
  },
  {
    name: "Crece",
    price: 249,
    blurb: "Para una tienda que ya vende todos los días.",
    recommended: true,
    features: [
      { text: "Todo lo de Emprende" },
      { text: "Hasta 3 números de WhatsApp" },
      { text: "Productos ilimitados" },
      { text: "6 usuarios del equipo" },
      { text: "Reportes de ventas" },
      { text: "Campañas y recordatorios", soon: true },
      { text: "Instagram", soon: true },
    ],
  },
  {
    name: "Escala",
    price: 599,
    blurb: "Para operar varias tiendas o canales.",
    features: [
      { text: "Todo lo de Crece" },
      { text: "Números y usuarios ilimitados" },
      { text: "Sincronización con Shopify", soon: true },
      { text: "Ventas por anuncio de Meta", soon: true },
      { text: "Soporte prioritario" },
    ],
  },
];

const faqs = [
  {
    q: "¿Cómo funciona la prueba gratis?",
    a: "Tienes 14 días con las funciones del plan que elijas, sin tarjeta. Al terminar, eliges un plan para seguir usándolo.",
  },
  {
    q: "¿Los precios incluyen IGV? ¿Emiten comprobante?",
    a: "Los precios no incluyen IGV. Emitimos factura o boleta por cada pago, según lo que tu negocio necesite.",
  },
  {
    q: "¿Necesito una clave de OpenAI?",
    a: "Sí. Cada tienda conecta su propia clave, así que el uso del modelo lo cobra OpenAI directamente y no VendeYa.",
  },
  {
    q: "¿Puedo usar mi número de WhatsApp actual?",
    a: "Sí. Al crear tu cuenta, el equipo de VendeYa te ayuda a conectar tu número.",
  },
  {
    q: "¿Puedo cancelar cuando quiera?",
    a: "Sí. Es un servicio mensual sin permanencia: cancelas y dejas de pagar desde el siguiente ciclo.",
  },
];
</script>

<PageTitle title="Precios" />
<svelte:head>
	<meta
		name="description"
		content="Precios de VendeYa en soles: Emprende S/ 99, Crece S/ 249 y Escala S/ 599 al mes más IGV. 14 días gratis, sin tarjeta."
	/>
	<meta property="og:title" content="Precios | VendeYa" />
	<meta
		property="og:description"
		content="Planes desde S/ 99 al mes más IGV para vender por WhatsApp con un asistente. 14 días gratis, sin tarjeta."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:url" content="https://sales.rising.sh/precios" />
	<meta property="og:image" content="https://sales.rising.sh/landing/og.png" />
	<meta property="og:locale" content="es_PE" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<SiteShell user={data.user}>
	<section class="mx-auto max-w-6xl px-4 pt-14 pb-16 md:px-6 md:pt-20 md:pb-24">
		<h1 class="text-3xl font-medium text-fg md:text-4xl">Precios</h1>
		<p class="mt-4 max-w-xl text-md text-fg-muted">
			En soles, por mes, más IGV. Empieza con 14 días gratis, sin tarjeta.
		</p>

		<div class="mt-12 grid gap-6 md:grid-cols-3">
			{#each plans as plan}
				<section
					class="flex flex-col rounded-lg border bg-surface p-6 {plan.recommended
						? 'border-accent'
						: 'border-border'}"
					aria-label="Plan {plan.name}"
				>
					<div class="flex items-center gap-2">
						<h2 class="text-lg font-medium text-fg">{plan.name}</h2>
						{#if plan.recommended}
							<Badge variant="accent">Recomendado</Badge>
						{/if}
					</div>
					<p class="mt-1 text-sm text-fg-muted">{plan.blurb}</p>
					<p class="mt-5">
						<span class="text-3xl font-medium tabular-nums text-fg">S/ {plan.price}</span>
						<span class="text-base text-fg-muted">/ mes + IGV</span>
					</p>
					<ul class="mt-6 flex-1 space-y-2.5 border-t border-border-subtle pt-6">
						{#each plan.features as feature}
							<li class="flex items-baseline gap-2.5 text-base text-fg-muted">
								<span class="shrink-0 text-fg-subtle" aria-hidden="true">—</span>
								<span
									>{feature.text}{#if feature.soon}
										<Badge class="ml-1.5">Pronto</Badge>
									{/if}</span
								>
							</li>
						{/each}
					</ul>
					<div class="mt-6">
						<Button
							href="/registro"
							variant={plan.recommended ? "primary" : "secondary"}
							class="w-full"
						>
							Crear cuenta gratis
						</Button>
					</div>
				</section>
			{/each}
		</div>

		<p class="mt-8 max-w-3xl text-sm text-fg-muted">
			Cada tienda conecta su propia clave de OpenAI, así que el uso del modelo lo
			cobra OpenAI y no VendeYa. Los mensajes de WhatsApp los cobra Meta según su
			tarifa.
		</p>
	</section>

	<section class="border-t border-border-subtle">
		<div class="mx-auto max-w-6xl px-4 py-14 md:px-6 md:py-20">
			<h2 class="text-2xl font-medium text-fg">Preguntas frecuentes</h2>
			<div class="mt-8 max-w-3xl divide-y divide-border-subtle border-y border-border-subtle">
				{#each faqs as faq}
					<details class="group">
						<summary
							class="flex cursor-pointer items-center justify-between gap-4 px-1 py-4 text-base font-medium text-fg select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
						>
							{faq.q}
							<span class="text-fg-subtle transition-transform duration-150 group-open:rotate-45" aria-hidden="true">+</span>
						</summary>
						<p class="px-1 pb-5 text-base text-fg-muted">{faq.a}</p>
					</details>
				{/each}
			</div>
		</div>
	</section>

	<section class="border-t border-border-subtle bg-surface">
		<div class="mx-auto max-w-6xl px-4 py-14 md:px-6 md:py-20">
			<div class="grid items-center gap-6 md:grid-cols-[1fr_auto]">
				<div>
					<h2 class="text-2xl font-medium text-fg">¿Te queda una duda?</h2>
					<p class="mt-3 max-w-xl text-md text-fg-muted">
						Escríbenos por
						<a
							href={SUPPORT.whatsappUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="text-fg underline underline-offset-2"
							>WhatsApp al {SUPPORT.phoneDisplay}</a
						>
						o a
						<a href="mailto:{SUPPORT.email}" class="text-fg underline underline-offset-2"
							>{SUPPORT.email}</a
						>.
					</p>
				</div>
				<Button href="/registro" size="lg">Crear cuenta gratis</Button>
			</div>
		</div>
	</section>
</SiteShell>
