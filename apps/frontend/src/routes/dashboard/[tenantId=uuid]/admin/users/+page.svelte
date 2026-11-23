<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import { onMount } from "svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { formatDate } from "#lib/utils/formatters.js";
import { roleLabel, roleLabels } from "#lib/utils/roles.js";

type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: number;
  created_at: number;
};

type Invitation = {
  id: string;
  email: string;
  role: string;
  expires_at: number;
};

let users = $state<User[]>([]);
let invitations = $state<Invitation[]>([]);
let loading = $state(true);

let inviteEmail = $state("");
let inviteRole = $state("sales_agent");
let inviting = $state(false);
/** The link of the invitation just created. The server keeps only its hash. */
let newLink = $state<{ email: string; link: string } | null>(null);

const roleItems = Object.entries(roleLabels).map(([value, label]) => ({
  value,
  label,
}));

async function load() {
  loading = true;
  try {
    const [usersRes, invitationsRes] = await Promise.all([
      fetchApi<{ users: User[] }>("/api/admin/users"),
      fetchApi<{ invitations: Invitation[] }>("/api/admin/invitations"),
    ]);
    users = usersRes.users;
    invitations = invitationsRes.invitations;
  } catch (e) {
    console.error(e);
  } finally {
    loading = false;
  }
}

async function invite(e: Event) {
  e.preventDefault();
  inviting = true;
  try {
    const email = inviteEmail.trim();
    const res = await fetchApi<{ id: string; link: string }>(
      "/api/admin/invitations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: inviteRole }),
      },
    );
    newLink = { email, link: res.link };
    inviteEmail = "";
    await load();
  } catch (err) {
    toast.error(
      err instanceof ApiError && err.status === 409
        ? "Esa persona ya es miembro del negocio"
        : "No se pudo crear la invitación. Revisa el correo.",
    );
  } finally {
    inviting = false;
  }
}

async function copyLink() {
  if (!newLink) return;
  await navigator.clipboard.writeText(newLink.link);
  toast.success("Enlace copiado");
}

async function revoke(invitation: Invitation) {
  try {
    await fetchApi(`/api/admin/invitations/${invitation.id}`, {
      method: "DELETE",
    });
    invitations = invitations.filter((i) => i.id !== invitation.id);
    if (newLink?.email === invitation.email) newLink = null;
    toast.success("Invitación anulada");
  } catch {
    toast.error("No se pudo anular la invitación");
  }
}

onMount(() => {
  load();
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

<div class="flex flex-col gap-6">
	<SectionShell title="Usuarios" description="Quién entra al panel y qué puede hacer.">
		<DataTable data={users} {columns} {loading} emptyMessage="No hay usuarios registrados." />
	</SectionShell>

	<SectionShell
		title="Invitar"
		description="Crea un enlace de invitación y envíalo a la persona. Vale 7 días y sirve una sola vez."
	>
		<form onsubmit={invite} class="p-4">
			<div class="grid gap-x-4 md:grid-cols-[minmax(0,1fr)_14rem_auto] md:items-end">
				<FormField label="Correo" for="invite-email">
					<Input id="invite-email" type="email" bind:value={inviteEmail} autocomplete="off" />
				</FormField>
				<FormField label="Rol" for="invite-role">
					<Select id="invite-role" bind:value={inviteRole} items={roleItems} />
				</FormField>
				<div class="mb-4">
					<Button type="submit" disabled={inviting || !inviteEmail.trim()}>
						{inviting ? "Creando…" : "Crear enlace"}
					</Button>
				</div>
			</div>

			{#if newLink}
				<div class="rounded-sm border border-border-subtle bg-sunken p-3">
					<p class="text-sm text-fg-muted">
						Enlace para {newLink.email}. Cópialo ahora: no se vuelve a mostrar.
					</p>
					<div class="mt-2 flex items-center gap-2">
						<code class="min-w-0 flex-1 font-mono text-sm break-all text-fg select-all">{newLink.link}</code>
						<Button type="button" variant="secondary" onclick={copyLink}>Copiar</Button>
					</div>
				</div>
			{/if}
		</form>

		{#if invitations.length > 0}
			<ul class="divide-y divide-border-subtle border-t border-border-subtle">
				{#each invitations as invitation (invitation.id)}
					<li class="flex items-center justify-between gap-4 px-4 py-2.5">
						<div class="min-w-0">
							<p class="truncate text-base text-fg">{invitation.email}</p>
							<p class="text-sm text-fg-muted">
								{roleLabel(invitation.role)} · vence {formatDate(invitation.expires_at)}
							</p>
						</div>
						<Button size="sm" variant="secondary" onclick={() => revoke(invitation)}>Anular</Button>
					</li>
				{/each}
			</ul>
		{/if}
	</SectionShell>
</div>

{#snippet nameCell(u: User)}
	<div class="text-fg">{u.name}</div>
	<div class="text-sm text-fg-muted">{u.email}</div>
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
	<a href="{businessPath()}/admin/users/{u.id}" class="text-sm text-accent-text hover:underline">Gestionar</a>
{/snippet}
