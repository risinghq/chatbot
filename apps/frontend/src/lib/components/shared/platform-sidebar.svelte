<script lang="ts">
import { auth } from "#lib/state/auth.svelte.js";
import SidebarFrame, {
  type NavItem,
  type NavSection,
} from "./sidebar-frame.svelte";

const sections = $derived.by((): NavSection[] => {
  const platform: NavItem[] = [
    { href: "/dashboard/negocios", label: "Negocios", icon: "building" },
    { href: "/dashboard/reports", label: "Reportes", icon: "chart" },
    { href: "/dashboard/historial", label: "Historial", icon: "activity" },
  ];
  if (auth.canAccessProviders) {
    platform.push({
      href: "/dashboard/providers",
      label: "Proveedores",
      icon: "card",
    });
  }
  platform.push({
    href: "/dashboard/ajustes",
    label: "Ajustes",
    icon: "sliders",
  });
  const businesses: NavItem[] = auth.tenants.map((t) => ({
    href: `/dashboard/${t.id}`,
    label: t.name,
    icon: "building",
  }));
  return [
    { title: null, items: platform },
    { title: "Entrar a un negocio", items: businesses },
  ];
});
</script>

<SidebarFrame home="/dashboard/negocios" {sections}>
	{#snippet scope()}
		<div class="px-2">
			<p class="text-xs text-fg-muted">Área</p>
			<p class="truncate text-base text-fg">Plataforma</p>
		</div>
	{/snippet}
</SidebarFrame>
