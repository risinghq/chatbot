<script lang="ts">
import { onMount } from "svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { fetchApi, ApiError } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import { roleLabel } from "#lib/utils/roles.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import SetupChecklist from "#lib/components/shared/setup-checklist.svelte";

type Member = {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: number;
};

let newName = $state("");
let creating = $state(false);

let members = $state<Member[]>([]);
let membersLoading = $state(false);

const activeTenant = $derived(
  auth.tenants.find((t) => t.id === auth.activeTenantId),
);

async function createBusiness(e: Event) {
  e.preventDefault();
  creating = true;
  try {
    const tenant = await fetchApi<{ id: string; name: string }>(
      "/api/tenants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      },
    );
    toast.success(`Negocio ${tenant.name} creado`);
    // Enter it so the checklist and the team act on the new business.
    await auth.selectTenant(tenant.id);
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Error al crear el negocio",
    );
    creating = false;
  }
}

async function loadMembers() {
  if (!auth.activeTenantId) {
    members = [];
    return;
  }
  membersLoading = true;
  try {
    const res = await fetchApi<{ users: Member[] }>("/api/admin/users");
    members = res.users;
  } catch {
    members = [];
  } finally {
    membersLoading = false;
  }
}

onMount(() => {
  loadMembers();
});
</script>

<PageTitle title="Negocios" />

<Page>
	<PageHeader title="Negocios" subtitle="Crea negocios, entra a uno y deja listo su equipo." />

	<div class="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
		<div class="flex flex-col gap-6">
			<SectionShell title="Negocios" description="Entra a un negocio para administrarlo.">
				{#if auth.tenants.length === 0}
					<EmptyState title="Sin negocios" description="Crea el primero con el formulario de abajo." />
				{:else}
					<ul class="divide-y divide-border-subtle">
						{#each auth.tenants as tenant (tenant.id)}
							<li class="flex items-center justify-between gap-4 px-4 py-3">
								<p class="min-w-0 truncate text-base text-fg">{tenant.name}</p>
								{#if auth.activeTenantId === tenant.id}
									<Badge variant="accent">Activo</Badge>
								{:else}
									<Button size="sm" variant="secondary" onclick={() => auth.selectTenant(tenant.id)}>Entrar</Button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</SectionShell>

			<form onsubmit={createBusiness}>
				<SectionShell title="Crear negocio" description="Nace sin catálogo, números ni miembros. Entras a él al crearlo.">
					<div class="p-4">
						<FormField label="Nombre" for="business-name" class="mb-0!">
							<Input id="business-name" bind:value={newName} placeholder="Bodega Los Andes" />
						</FormField>
					</div>
					<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
						<Button type="submit" disabled={creating || !newName.trim()}>
							{creating ? "Creando…" : "Crear negocio"}
						</Button>
					</footer>
				</SectionShell>
			</form>
		</div>

		<div class="flex flex-col gap-6">
			{#if activeTenant}
				<SetupChecklist />

				<SectionShell title="Miembros de {activeTenant.name}" description="Quién puede entrar al panel de este negocio.">
					{#if membersLoading}
						<div class="p-4" aria-busy="true">
							<div class="h-8 animate-pulse rounded-sm bg-sunken"></div>
						</div>
					{:else if members.length === 0}
						<p class="px-4 py-3 text-base text-fg-muted">Este negocio no tiene miembros todavía.</p>
					{:else}
						<ul class="divide-y divide-border-subtle">
							{#each members as member (member.id)}
								<li class="flex items-center justify-between gap-4 px-4 py-2.5">
									<div class="min-w-0">
										<p class="truncate text-base text-fg">{member.name}</p>
										<p class="truncate text-sm text-fg-muted">{member.email}</p>
									</div>
									<span class="text-sm text-fg-muted">{roleLabel(member.role)}</span>
								</li>
							{/each}
						</ul>
					{/if}

					<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
						<Button size="sm" variant="secondary" href="/dashboard/admin/users">Invitar miembros</Button>
					</footer>
				</SectionShell>
			{:else}
				<div class="rounded-md border border-border bg-surface">
					<EmptyState
						title="Ningún negocio activo"
						description="Entra a un negocio para ver lo que le falta configurar y su equipo."
					/>
				</div>
			{/if}
		</div>
	</div>
</Page>
