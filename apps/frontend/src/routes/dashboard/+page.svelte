<script lang="ts">
import type { Conversation, OrderMetrics } from "@vendeya/types";
import { onMount } from "svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import SetupChecklist from "#lib/components/shared/setup-checklist.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import { formatDateTime, formatPhone } from "#lib/utils/formatters.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

// The tenant's OpenAI key is what lets the bot think. The tenant list the
// layout loaded says whether it is stored, so the page can warn before a
// customer finds out. With no business active there is no key to report on.
let activeTenant = $derived(
  auth.tenants.find((t) => t.id === auth.activeTenantId),
);
let aiConfigured = $derived(activeTenant?.ai_configured === true);

let conversations = $state<Conversation[] | null>(null);
let metrics = $state<OrderMetrics | null>(null);

let waiting = $derived(
  (conversations ?? [])
    .filter((c) => c.status === "human_takeover")
    .sort((a, b) => b.last_activity_at - a.last_activity_at),
);
let activeCount = $derived(
  (conversations ?? []).filter((c) => c.status === "active").length,
);

// A child mounts before the root layout hydrates `auth`, so the gate reads the
// server-loaded user.
onMount(() => {
  if (!data.user?.activeTenantId) return;
  fetchApi<Conversation[]>("/api/conversations")
    .then((list) => (conversations = list))
    .catch(() => (conversations = []));
  // Sales agents cannot read order metrics; the tile hides instead of failing.
  fetchApi<OrderMetrics>("/api/orders/metrics")
    .then((m) => (metrics = m))
    .catch(() => (metrics = null));
});
</script>

<PageTitle title="Inicio" />

<div class="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
	<PageHeader
		title="Hola, {data.user?.name || data.user?.email}"
		subtitle={activeTenant ? activeTenant.name : undefined}
	/>

	<div class="flex flex-col gap-4">
		{#if auth.isPlatformOperator && auth.tenants.length === 0}
			<section class="rounded-md border border-border bg-surface">
				<EmptyState
					title="Todavía no hay negocios"
					description="Crea el primer negocio para conectar su número de WhatsApp y su clave de OpenAI."
				>
					{#snippet action()}
						<Button href="/dashboard/negocios">Crear el primer negocio</Button>
					{/snippet}
				</EmptyState>
			</section>
		{:else if !auth.activeTenantId}
			<Banner tone="info" title="Ningún negocio seleccionado">
				Elige un negocio en el menú para ver sus conversaciones y órdenes.
				{#snippet action()}
					{#if auth.isPlatformOperator}
						<Button href="/dashboard/negocios" variant="secondary" size="sm">Ir a Negocios</Button>
					{/if}
				{/snippet}
			</Banner>
		{:else}
			{#if !aiConfigured}
				<Banner tone="warning" title="Falta la clave de OpenAI">
					Sin ella el bot no puede interpretar los mensajes de los clientes.
					{#snippet action()}
						{#if auth.isAdmin || auth.isPlatformOperator}
							<Button href="/dashboard/admin/settings" variant="secondary" size="sm">Configurar</Button>
						{/if}
					{/snippet}
				</Banner>
			{/if}

			{#if auth.isAdmin}
				<SetupChecklist />
			{/if}

			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
				<a
					href="/dashboard/conversations"
					class="rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong"
				>
					<p class="text-sm text-fg-muted">Esperan a una persona</p>
					<p class="mt-1 text-xl text-fg tabular-nums">{conversations ? waiting.length : "–"}</p>
				</a>
				<a
					href="/dashboard/conversations"
					class="rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong"
				>
					<p class="text-sm text-fg-muted">Atendidas por el bot</p>
					<p class="mt-1 text-xl text-fg tabular-nums">{conversations ? activeCount : "–"}</p>
				</a>
				{#if metrics}
					<a
						href="/dashboard/orders?status=pending"
						class="rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong"
					>
						<p class="text-sm text-fg-muted">Órdenes por aprobar</p>
						<p class="mt-1 text-xl text-fg tabular-nums">{metrics.pendingCount}</p>
					</a>
				{/if}
			</div>

			<section class="rounded-md border border-border bg-surface">
				<header class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
					<h2 class="text-md text-fg">Requieren atención</h2>
					<a href="/dashboard/conversations" class="text-sm text-fg-muted hover:text-fg">Ver todas</a>
				</header>
				{#if conversations === null}
					<p class="px-4 py-6 text-base text-fg-muted">Cargando…</p>
				{:else if waiting.length === 0}
					<EmptyState
						title="Nada pendiente"
						description="Cuando el bot pase una conversación a una persona, aparecerá aquí."
					/>
				{:else}
					<ul class="divide-y divide-border-subtle">
						{#each waiting.slice(0, 6) as conv (conv.channel_account_id + conv.phone_number)}
							<li>
								<a
									href="/dashboard/conversations/{conv.phone_number}?channel={conv.channel_account_id}"
									class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
								>
									<div class="min-w-0 flex-1">
										<p class="truncate text-base text-fg">
											{conv.client_name || formatPhone(conv.phone_number)}
										</p>
										{#if conv.handover_reason}
											<p class="truncate text-sm text-fg-muted">{conv.handover_reason}</p>
										{/if}
									</div>
									<span class="shrink-0 text-sm text-fg-muted tabular-nums">
										{formatDateTime(conv.last_activity_at)}
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</div>
</div>
