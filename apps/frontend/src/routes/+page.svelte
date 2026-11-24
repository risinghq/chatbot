<script lang="ts">
import Button from "#lib/components/ui/button.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import SiteShell from "#lib/components/marketing/site-shell.svelte";
import Screenshot from "#lib/components/marketing/screenshot.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import { SUPPORT } from "#lib/utils/support.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

const steps = [
  {
    title: "Carga tu catálogo",
    body: "Sube un Excel o CSV. Al empezar, una bienvenida te pregunta qué vendes y arma los formularios de tus productos.",
  },
  {
    title: "El asistente atiende",
    body: "Responde en WhatsApp con el precio y el stock reales, envía las fotos de la variante exacta y toma el pedido.",
  },
  {
    title: "Cobra y entrega",
    body: "El cliente paga con un link TAYPI: Yape, Plin o tarjeta. El pago queda registrado en el pedido.",
  },
];

const upcoming = [
  "Campañas y recordatorios automáticos: carritos abandonados y clientes inactivos",
  "Mensajes y comentarios de Instagram",
  "App instalable para el celular",
  "Sincronización con Shopify",
  "Ventas por anuncio de Meta",
];
</script>

<PageTitle title="Vende por WhatsApp con un asistente" />
<svelte:head>
	<meta
		name="description"
		content="VendeYa atiende el WhatsApp de tu tienda: responde con el precio y el stock reales de tu catálogo, toma pedidos y cobra con link de pago. 14 días gratis."
	/>
	<meta property="og:title" content="VendeYa — Vende por WhatsApp con un asistente" />
	<meta
		property="og:description"
		content="Un asistente responde a tus clientes con el precio y el stock reales de tu catálogo, toma el pedido y cobra con un link de pago."
	/>
	<meta property="og:type" content="website" />
	<meta property="og:url" content="https://sales.rising.sh/" />
	<meta property="og:image" content="https://sales.rising.sh/landing/og.png" />
	<meta property="og:locale" content="es_PE" />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>

<SiteShell user={data.user}>
	<section class="mx-auto max-w-6xl px-4 pt-14 pb-16 md:px-6 md:pt-24 md:pb-20">
		<div class="max-w-2xl">
			<h1 class="text-3xl font-medium text-fg md:text-4xl">
				Vende por WhatsApp sin vivir pegado al celular
			</h1>
			<p class="mt-4 max-w-xl text-md text-fg-muted">
				Un asistente atiende a tus clientes con el precio y el stock reales de tu
				catálogo, toma el pedido y cobra con un link de pago. Tú solo entregas.
			</p>
			<div class="mt-8 flex flex-wrap items-center gap-3">
				<Button href="/registro" size="lg">Crear cuenta gratis</Button>
				<Button href="/precios" size="lg" variant="secondary">Ver precios</Button>
			</div>
			<p class="mt-3 text-sm text-fg-muted">14 días gratis. No pide tarjeta.</p>
		</div>
		<div class="mt-12 md:mt-16">
			<Screenshot
				src="/landing/conversacion.webp"
				alt="Una conversación del panel de VendeYa: el asistente responde al cliente y el botón Intervenir permite que una persona tome el chat."
			/>
		</div>
	</section>

	<section class="border-t border-border-subtle">
		<div class="mx-auto max-w-6xl px-4 py-14 md:px-6 md:py-20">
			<h2 class="text-2xl font-medium text-fg">Así funciona</h2>
			<ol class="mt-8 grid gap-10 md:grid-cols-3 md:gap-8">
				{#each steps as step, i}
					<li>
						<p class="text-sm font-medium text-accent-text">{i + 1}</p>
						<h3 class="mt-2 text-lg font-medium text-fg">{step.title}</h3>
						<p class="mt-2 text-base text-fg-muted">{step.body}</p>
					</li>
				{/each}
			</ol>
		</div>
	</section>

	<section class="border-t border-border-subtle">
		<div class="mx-auto max-w-6xl space-y-16 px-4 py-14 md:space-y-24 md:px-6 md:py-20">
			<div class="grid items-center gap-8 md:grid-cols-2 md:gap-12">
				<div>
					<h2 class="text-2xl font-medium text-fg">
						Del mensaje al pedido, sin que intervengas
					</h2>
					<p class="mt-4 text-md text-fg-muted">
						El asistente toma el pedido, reserva el stock y envía el link de
						pago. En el panel ves cada pedido con su estado: por confirmar, por
						despachar, por cobrar o entregado.
					</p>
					<p class="mt-4 text-md text-fg-muted">
						Y cuando hace falta, una persona toma el chat en cualquier momento y
						se lo devuelve al asistente después.
					</p>
				</div>
				<Screenshot
					src="/landing/pedidos.webp"
					alt="La página Pedidos del panel: pedidos en estados pendiente, confirmado, empacado y entregado, con su pago."
				/>
			</div>

			<div class="grid items-center gap-8 md:grid-cols-2 md:gap-12">
				<div class="md:order-2">
					<h2 class="text-2xl font-medium text-fg">
						Tu catálogo es la verdad
					</h2>
					<p class="mt-4 text-md text-fg-muted">
						Los precios y el stock salen de tu catálogo, no de la imaginación del
						modelo. Lo cargas desde un Excel o CSV y el mismo catálogo alimenta
						pedidos, inventario por almacén y reportes.
					</p>
				</div>
				<Screenshot
					src="/landing/catalogo.webp"
					alt="La página Catálogo del panel: la lista de productos con categoría, marca, modelo, variantes y estado."
				/>
			</div>
		</div>
	</section>

	<section class="border-t border-border-subtle">
		<div class="mx-auto max-w-6xl px-4 py-14 md:px-6 md:py-20">
			<div class="max-w-3xl">
				<h2 class="text-2xl font-medium text-fg">
					Hecho para tiendas de productos
				</h2>
				<p class="mt-4 text-md text-fg-muted">
					Para ecommerce y tiendas virtuales con venta de productos con precio
					definido: ropa, accesorios, perfumería y belleza, electrónica,
					mascotas y similares. Si vendes servicios, cotizas a medida o atiendes
					con cita previa, el agente puede apoyar en la atención inicial, pero la
					venta la cierras tú.
				</p>
				<p class="mt-4 text-base text-fg-muted">
					Pedidos, stock por almacén, zonas y tarifas de envío, clientes y
					reportes de ventas ya están incluidos. ¿Vendes electrodomésticos? Para
					ese caso hay una evaluación crediticia Cálidda opcional que el
					asistente corre dentro de la conversación.
				</p>
			</div>

			<div class="mt-12 max-w-3xl">
				<h3 class="text-lg font-medium text-fg">Lo que sigue</h3>
				<ul class="mt-4 space-y-3">
					{#each upcoming as item}
						<li class="flex items-baseline gap-3 text-base text-fg-muted">
							<span class="shrink-0"><Badge>Pronto</Badge></span>
							<span>{item}</span>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	</section>

	<section class="border-t border-border-subtle">
		<div class="mx-auto max-w-6xl px-4 py-14 md:px-6 md:py-20">
			<div class="grid items-center gap-6 md:grid-cols-[1fr_auto]">
				<div>
					<h2 class="text-2xl font-medium text-fg">
						Planes desde S/ 99 al mes
					</h2>
					<p class="mt-3 max-w-xl text-md text-fg-muted">
						Precios en soles más IGV. Empieza con 14 días gratis, sin tarjeta, y
						pruébalo con tu propio catálogo.
					</p>
				</div>
				<Button href="/precios" size="lg" variant="secondary">Ver precios</Button>
			</div>
		</div>
	</section>

	<section class="border-t border-border-subtle bg-surface">
		<div class="mx-auto max-w-6xl px-4 py-16 text-center md:px-6 md:py-24">
			<h2 class="mx-auto max-w-xl text-2xl font-medium text-fg md:text-3xl">
				Crea tu cuenta y pruébalo con tu propio catálogo
			</h2>
			<div class="mt-8 flex justify-center">
				<Button href="/registro" size="lg">Crear cuenta gratis</Button>
			</div>
			<p class="mt-4 text-sm text-fg-muted">
				¿Dudas? Escríbenos por
				<a
					href={SUPPORT.whatsappUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="text-fg underline underline-offset-2">WhatsApp</a
				>
				o a
				<a href="mailto:{SUPPORT.email}" class="text-fg underline underline-offset-2"
					>{SUPPORT.email}</a
				>.
			</p>
		</div>
	</section>
</SiteShell>
