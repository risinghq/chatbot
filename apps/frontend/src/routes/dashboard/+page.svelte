<script lang="ts">
import Badge from "#lib/components/ui/badge.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();
</script>

<PageTitle title="Elige un negocio" />

<div class="flex min-h-dvh flex-col items-center bg-canvas p-4 pt-[12vh]">
	<div class="w-full max-w-md">
		<div class="mb-6 flex items-center justify-between gap-4">
			<h1 class="text-lg font-medium text-fg">vendeya</h1>
			<button
				type="button"
				onclick={() => auth.logout()}
				class="inline-flex h-8 items-center gap-2 rounded-sm px-2 text-base text-fg-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:h-11"
			>
				<Icon name="logout" />
				Salir
			</button>
		</div>

		<div class="rounded-lg border border-border bg-surface shadow-sm">
			<div class="border-b border-border-subtle px-4 py-3">
				<p class="text-base text-fg">Elige un negocio</p>
				<p class="text-sm text-fg-muted">{auth.user?.email}</p>
			</div>

			{#if data.tenants.length === 0}
				<p class="px-4 py-6 text-base text-fg-muted">
					{#if auth.isPlatformOperator}
						Todavía no hay negocios. Crea el primero en Negocios.
					{:else}
						Tu cuenta no pertenece a ningún negocio. Pide a quien lo administra que te invite.
					{/if}
				</p>
			{:else}
				<ul class="divide-y divide-border-subtle">
					{#each data.tenants as tenant (tenant.id)}
						<li>
							<a
								href="/dashboard/{tenant.id}"
								class="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-hover"
							>
								<span class="min-w-0 truncate text-base text-fg">{tenant.name}</span>
								{#if auth.isPlatformOperator && !tenant.ai_configured}
									<Badge variant="warning">Sin clave de OpenAI</Badge>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			{/if}

			{#if auth.isPlatformOperator}
				<div class="flex flex-wrap gap-1 border-t border-border-subtle px-2 py-2">
					<a href="/dashboard/negocios" class="flex h-8 items-center gap-2 rounded-sm px-2 text-base text-fg-muted transition-colors hover:bg-hover hover:text-fg">
						<Icon name="building" /> Negocios
					</a>
					<a href="/dashboard/reports" class="flex h-8 items-center gap-2 rounded-sm px-2 text-base text-fg-muted transition-colors hover:bg-hover hover:text-fg">
						<Icon name="chart" /> Reportes de la plataforma
					</a>
				</div>
			{/if}
		</div>
	</div>
</div>
