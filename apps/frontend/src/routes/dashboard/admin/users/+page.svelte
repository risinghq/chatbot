<script lang="ts">
import { onMount } from "svelte";
import NeedsTenant from "#lib/components/shared/needs-tenant.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { fetchApi } from "#lib/utils/api.js";
import { formatDate } from "#lib/utils/formatters.js";
import { roleLabel } from "#lib/utils/roles.js";

let { data } = $props();

type User = {
  id: string;
  username: string;
  name: string;
  role: string;
  is_active: number;
  created_at: number;
};

let users = $state<User[]>([]);
let loading = $state(true);

async function loadUsers() {
  loading = true;
  try {
    const res = await fetchApi<{ users: User[] }>("/api/admin/users");
    users = res.users;
  } catch (e) {
    console.error(e);
  } finally {
    loading = false;
  }
}

onMount(() => {
  if (data.user?.activeTenantId) loadUsers();
});

const roleVariants: Record<string, "accent" | "info" | "default" | "success"> =
  {
    admin: "accent",
    developer: "info",
    supervisor: "default",
    sales_agent: "success",
  };

const columns = [
  { header: "Nombre", cell: nameCell },
  { header: "Rol", cell: roleCell },
  { header: "Estado", cell: statusCell },
  { header: "Creado", cell: createdCell },
  { header: "", align: "right" as const, cell: actionsCell },
];
</script>

{#if !data.user?.activeTenantId}
	<NeedsTenant />
{:else}
	<SectionShell title="Usuarios" description="Quién entra al panel y qué puede hacer." action={headerAction}>
		<DataTable data={users} {columns} {loading} emptyMessage="No hay usuarios registrados." />
	</SectionShell>
{/if}

{#snippet headerAction()}
	<Button href="/dashboard/admin/users/create" size="sm">Nuevo usuario</Button>
{/snippet}

{#snippet nameCell(u: User)}
	<div class="text-fg">{u.name}</div>
	<div class="font-mono text-sm text-fg-muted">@{u.username}</div>
{/snippet}

{#snippet roleCell(u: User)}
	<Badge variant={roleVariants[u.role] ?? "default"}>{roleLabel(u.role)}</Badge>
{/snippet}

{#snippet statusCell(u: User)}
	<Badge variant={u.is_active ? "success" : "default"}>{u.is_active ? "Activo" : "Inactivo"}</Badge>
{/snippet}

{#snippet createdCell(u: User)}
	<span class="text-fg-muted tabular-nums">{formatDate(u.created_at)}</span>
{/snippet}

{#snippet actionsCell(u: User)}
	<a href="/dashboard/admin/users/{u.id}" class="text-sm text-accent-text hover:underline">Gestionar</a>
{/snippet}
