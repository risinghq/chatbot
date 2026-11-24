<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import { page } from "$app/state";
import { auth } from "#lib/state/auth.svelte.js";

let { class: className = "" }: { class?: string } = $props();

const tabs = $derived([
  { href: businessPath("/asistente"), label: "Configuración" },
  ...(auth.canAccessSimulator
    ? [
        { href: businessPath("/asistente/probar"), label: "Probar" },
        { href: businessPath("/asistente/registro"), label: "Registro" },
      ]
    : []),
]);
</script>

{#if tabs.length > 1}
	<nav class="flex gap-1 overflow-x-auto {className}" aria-label="Asistente">
		{#each tabs as tab (tab.href)}
			{@const active = page.url.pathname === tab.href}
			<a
				href={tab.href}
				class="-mb-px flex h-9 shrink-0 items-center border-b-2 px-2 text-base transition-colors duration-150 ease-out {active
					? 'border-fg text-fg'
					: 'border-transparent text-fg-muted hover:text-fg'}"
				aria-current={active ? "page" : undefined}
			>
				{tab.label}
			</a>
		{/each}
	</nav>
{/if}
