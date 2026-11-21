<script lang="ts">
import { page } from "$app/state";
import Icon, { type IconName } from "#lib/components/ui/icon.svelte";
import { fieldStyles } from "#lib/components/ui/field-styles.js";
import { auth } from "#lib/state/auth.svelte.js";
import { roleLabel } from "#lib/utils/roles.js";

type NavItem = { href: string; label: string; icon: IconName; match?: string };

const sections = $derived.by(() => {
  const work: NavItem[] = [
    { href: "/dashboard", label: "Inicio", icon: "home" },
    { href: "/dashboard/conversations", label: "Conversaciones", icon: "chat" },
    { href: "/dashboard/orders", label: "Pedidos", icon: "bag" },
    { href: "/dashboard/envios", label: "Envíos", icon: "truck" },
    { href: "/dashboard/clientes", label: "Clientes", icon: "user" },
    { href: "/dashboard/catalog", label: "Catálogo", icon: "box" },
    { href: "/dashboard/inventario", label: "Inventario", icon: "warehouse" },
  ];
  const tools: NavItem[] = [
    { href: "/dashboard/asistente", label: "Asistente", icon: "bot" },
  ];
  if (auth.canAccessReports) {
    tools.push({
      href: "/dashboard/activity",
      label: "Actividad",
      icon: "activity",
    });
    tools.push({
      href: "/dashboard/reports",
      label: "Reportes",
      icon: "chart",
    });
  }
  if (auth.isAdmin) {
    tools.push({
      href: "/dashboard/admin/users",
      label: "Administración",
      icon: "sliders",
      match: "/dashboard/admin",
    });
  }
  const platform: NavItem[] = [];
  if (auth.isPlatformOperator)
    platform.push({
      href: "/dashboard/negocios",
      label: "Negocios",
      icon: "building",
    });
  if (auth.canAccessProviders)
    platform.push({
      href: "/dashboard/providers",
      label: "Proveedores",
      icon: "card",
    });

  return [
    { title: null, items: work },
    { title: "Herramientas", items: tools },
    { title: "Plataforma", items: platform },
  ].filter((s) => s.items.length > 0);
});

function isActive(item: NavItem): boolean {
  const path = page.url.pathname;
  if (item.href === "/dashboard") return path === "/dashboard";
  const base = item.match ?? item.href;
  return path === base || path.startsWith(`${base}/`);
}

const activeTenantName = $derived(
  auth.tenants.find((t) => t.id === auth.activeTenantId)?.name,
);
</script>

<div class="flex h-full flex-col gap-4 p-3">
	<a href="/dashboard" class="flex h-8 items-center px-2 text-md font-medium text-fg">vendeya</a>

	{#if auth.canSwitchTenant}
		<label class="block px-1">
			<span class="mb-1 block px-1 text-xs text-fg-muted">Negocio</span>
			<select
				class="{fieldStyles(false)} h-8 py-0 pr-8 pointer-coarse:h-11"
				value={auth.activeTenantId ?? ""}
				onchange={(e) => auth.selectTenant(e.currentTarget.value || null)}
			>
				{#if auth.isPlatformOperator}
					<option value="">Todos (operador)</option>
				{:else if !auth.activeTenantId}
					<option value="">Selecciona un negocio</option>
				{/if}
				{#each auth.tenants as tenant (tenant.id)}
					<option value={tenant.id}>{tenant.name}</option>
				{/each}
			</select>
		</label>
	{:else if activeTenantName}
		<div class="px-2">
			<p class="text-xs text-fg-muted">Negocio</p>
			<p class="truncate text-base text-fg">{activeTenantName}</p>
		</div>
	{/if}

	<nav class="flex flex-1 flex-col gap-4 overflow-y-auto" aria-label="Principal">
		{#each sections as section (section.title)}
			<div>
				{#if section.title}
					<p class="mb-1 px-2 text-xs text-fg-muted">{section.title}</p>
				{/if}
				<ul class="flex flex-col gap-px">
					{#each section.items as item (item.href)}
						{@const active = isActive(item)}
						<li>
							<a
								href={item.href}
								aria-current={active ? "page" : undefined}
								class="flex h-8 items-center gap-2.5 rounded-sm px-2 text-base transition-colors duration-150 ease-out pointer-coarse:h-11 {active
									? 'bg-sunken-strong text-fg'
									: 'text-fg-muted hover:bg-hover hover:text-fg'}"
							>
								<Icon name={item.icon} />
								{item.label}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</nav>

	<div class="flex flex-col gap-2 border-t border-border-subtle pt-3">
		{#if auth.isSalesAgent}
			<button
				type="button"
				role="switch"
				aria-checked={auth.isAvailable}
				onclick={() => auth.toggleAvailability()}
				class="flex h-8 items-center gap-2.5 rounded-sm px-2 text-base text-fg transition-colors hover:bg-hover pointer-coarse:h-11"
			>
				<span class="size-2 rounded-full {auth.isAvailable ? 'bg-success' : 'bg-fg-subtle'}"></span>
				{auth.isAvailable ? "Disponible" : "No disponible"}
			</button>
		{/if}
		<div class="flex items-center gap-2 px-2">
			<a
				href="/dashboard/cuenta"
				title="Mi cuenta"
				class="-mx-1 min-w-0 flex-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-hover"
			>
				<p class="truncate text-base text-fg">{auth.user?.name || auth.user?.email}</p>
				<p class="truncate text-xs text-fg-muted">
					{auth.isPlatformOperator ? "Operador de plataforma" : roleLabel(auth.user?.role)}
				</p>
			</a>
			<button
				type="button"
				onclick={() => auth.logout()}
				class="inline-flex size-8 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:size-11"
				aria-label="Salir"
				title="Salir"
			>
				<Icon name="logout" />
			</button>
		</div>
	</div>
</div>
