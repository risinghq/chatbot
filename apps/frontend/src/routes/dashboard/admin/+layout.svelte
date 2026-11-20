<script lang="ts">
import { page } from "$app/state";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

let { children } = $props();

const tabs = [
  { href: "/dashboard/admin/users", label: "Usuarios" },
  { href: "/dashboard/admin/periods", label: "Periodos" },
  { href: "/dashboard/admin/audit", label: "Auditoría" },
  { href: "/dashboard/admin/channels", label: "Números" },
  { href: "/dashboard/admin/settings", label: "Configuración" },
];

function isActive(path: string) {
  const current = page.url.pathname;
  return current === path || current.startsWith(`${path}/`);
}
</script>

<PageTitle title="Administración" />

<Page>
	<PageHeader title="Administración" subtitle="Equipo, números y claves del negocio." />

	<nav class="-mx-4 mb-6 flex gap-1 overflow-x-auto border-b border-border-subtle px-4 md:mx-0 md:px-0" aria-label="Secciones">
		{#each tabs as tab (tab.href)}
			{@const active = isActive(tab.href)}
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

	{@render children()}
</Page>
