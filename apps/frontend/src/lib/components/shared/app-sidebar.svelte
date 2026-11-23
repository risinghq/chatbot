<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { fieldStyles } from "#lib/components/ui/field-styles.js";
import { auth } from "#lib/state/auth.svelte.js";
import { businessPath, samePageIn } from "#lib/state/business.svelte.js";
import SidebarFrame, {
  type NavItem,
  type NavSection,
} from "./sidebar-frame.svelte";

const sections = $derived.by((): NavSection[] => {
  const work: NavItem[] = [
    { href: businessPath(), label: "Inicio", icon: "home", exact: true },
    {
      href: businessPath("/conversations"),
      label: "Conversaciones",
      icon: "chat",
    },
    { href: businessPath("/orders"), label: "Pedidos", icon: "bag" },
    { href: businessPath("/envios"), label: "Envíos", icon: "truck" },
    { href: businessPath("/clientes"), label: "Clientes", icon: "user" },
    { href: businessPath("/catalog"), label: "Catálogo", icon: "box" },
    {
      href: businessPath("/inventario"),
      label: "Inventario",
      icon: "warehouse",
    },
  ];
  const tools: NavItem[] = [
    { href: businessPath("/asistente"), label: "Asistente", icon: "bot" },
  ];
  if (auth.canAccessReports) {
    tools.push(
      { href: businessPath("/activity"), label: "Actividad", icon: "activity" },
      { href: businessPath("/reports"), label: "Reportes", icon: "chart" },
    );
  }
  if (auth.isAdmin) {
    tools.push({
      href: businessPath("/admin/users"),
      label: "Administración",
      icon: "sliders",
      match: businessPath("/admin"),
    });
  }
  const platform: NavItem[] = [];
  if (auth.isPlatformOperator) {
    platform.push(
      { href: "/dashboard/negocios", label: "Negocios", icon: "building" },
      { href: "/dashboard/reports", label: "Reportes", icon: "chart" },
    );
  }
  if (auth.canAccessProviders) {
    platform.push({
      href: "/dashboard/providers",
      label: "Proveedores",
      icon: "card",
    });
  }
  return [
    { title: null, items: work },
    { title: "Herramientas", items: tools },
    { title: "Plataforma", items: platform },
  ];
});

const tenantId = $derived(page.params.tenantId ?? "");
const tenantName = $derived(auth.tenants.find((t) => t.id === tenantId)?.name);
</script>

<SidebarFrame home={businessPath()} {sections} account={businessPath("/cuenta")}>
	{#snippet scope()}
		{#if auth.tenants.length > 1}
			<label class="block px-1">
				<span class="mb-1 block px-1 text-xs text-fg-muted">Negocio</span>
				<select
					class="{fieldStyles(false)} h-8 py-0 pr-8 pointer-coarse:h-11"
					value={tenantId}
					onchange={(e) =>
						// A load that never reads the business id still answers for it.
						goto(samePageIn(e.currentTarget.value, page.url.pathname), { invalidateAll: true })}
				>
					{#each auth.tenants as tenant (tenant.id)}
						<option value={tenant.id}>{tenant.name}</option>
					{/each}
				</select>
			</label>
		{:else if tenantName}
			<div class="px-2">
				<p class="text-xs text-fg-muted">Negocio</p>
				<p class="truncate text-base text-fg">{tenantName}</p>
			</div>
		{/if}
	{/snippet}
</SidebarFrame>
