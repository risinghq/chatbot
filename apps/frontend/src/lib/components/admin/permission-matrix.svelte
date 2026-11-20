<script lang="ts">
type Props = {
  role: string;
};

let { role }: Props = $props();

const permissions: Record<string, { label: string; included: boolean }[]> = {
  admin: [
    { label: "Acceso total al sistema", included: true },
    { label: "Gestión de usuarios", included: true },
    { label: "Ver logs de auditoría", included: true },
    { label: "Configuración global", included: true },
    { label: "Cancelar pedidos y decidir pagos", included: true },
    { label: "Simulador de pruebas", included: true },
  ],
  developer: [
    { label: "Gestión de usuarios", included: false },
    { label: "Ver logs de auditoría", included: true },
    { label: "Configuración técnica", included: true },
    { label: "Simulador de pruebas", included: true },
    { label: "Editar catálogo", included: true },
    { label: "Despachar pedidos", included: true },
    { label: "Cancelar pedidos y decidir pagos", included: false },
  ],
  supervisor: [
    { label: "Gestión de usuarios", included: false },
    { label: "Despachar pedidos", included: true },
    { label: "Cancelar pedidos y decidir pagos", included: true },
    { label: "Editar catálogo", included: true },
    { label: "Ver reportes y métricas", included: true },
    { label: "Simulador de pruebas", included: false },
  ],
  sales_agent: [
    { label: "Atención de conversaciones", included: true },
    { label: "Ver catálogo (solo lectura)", included: true },
    { label: "Registrar pedidos y pagos", included: true },
    { label: "Ver solo sus pedidos", included: true },
    { label: "Despachar pedidos", included: false },
    { label: "Acceso a reportes", included: false },
    { label: "Modificar inventario", included: false },
  ],
};

const currentPermissions = $derived(permissions[role] || []);
</script>

<div class="mt-4">
	<p class="mb-2 text-sm text-fg-muted">
		Capacidades del rol <span class="font-mono text-fg">{role}</span>
	</p>
	<ul class="grid grid-cols-1 gap-x-4 gap-y-1.5 md:grid-cols-2">
		{#each currentPermissions as perm}
			<li class="flex items-center gap-2 text-base {perm.included ? 'text-fg' : 'text-fg-muted line-through'}">
				<span aria-hidden="true" class="w-3 text-center {perm.included ? 'text-success-text' : 'text-fg-subtle'}">{perm.included ? "✓" : "×"}</span>
				<span class="sr-only">{perm.included ? "Incluye:" : "No incluye:"}</span>
				{perm.label}
			</li>
		{/each}
	</ul>
</div>
