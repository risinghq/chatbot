<script lang="ts">
import { onMount } from "svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { fetchApi, ApiError } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import { roleLabel, roleLabels } from "#lib/utils/roles.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import SetupChecklist from "#lib/components/shared/setup-checklist.svelte";
import { MIN_PASSWORD_LENGTH } from "@vendeya/types";

type Member = {
  id: string;
  username: string;
  name: string;
  role: string;
  is_active: number;
};

let newName = $state("");
let newSlug = $state("");
let creating = $state(false);

let members = $state<Member[]>([]);
let membersLoading = $state(false);
let memberMode = $state<"new" | "existing">("new");
let memberUsername = $state("");
let memberFullName = $state("");
let memberPassword = $state("");
let memberRole = $state("admin");
let addingMember = $state(false);

const roleItems = Object.entries(roleLabels).map(([value, label]) => ({
  value,
  label,
}));

const activeTenant = $derived(
  auth.tenants.find((t) => t.id === auth.activeTenantId),
);

// The slug is a lookup key in the URL and the CLI, so the form derives a safe
// one from the name and lets the operator adjust it.
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

let slugTouched = $state(false);
$effect(() => {
  if (!slugTouched) newSlug = slugify(newName);
});

async function createBusiness(e: Event) {
  e.preventDefault();
  creating = true;
  try {
    const tenant = await fetchApi<{ id: string; name: string }>(
      "/api/tenants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: newSlug, name: newName }),
      },
    );
    toast.success(`Negocio ${tenant.name} creado`);
    // Enter it so the checklist and the member form act on the new business.
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

async function addMember(e: Event) {
  e.preventDefault();
  const tenantId = auth.activeTenantId;
  if (!tenantId) return;
  addingMember = true;
  try {
    if (memberMode === "existing") {
      await fetchApi(`/api/tenants/${tenantId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: memberUsername,
          role: memberRole,
        }),
      });
    } else {
      await fetchApi("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: memberUsername,
          name: memberFullName,
          password: memberPassword,
          role: memberRole,
        }),
      });
    }
    toast.success("Miembro agregado");
    memberUsername = "";
    memberFullName = "";
    memberPassword = "";
    memberRole = "admin";
    await loadMembers();
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Error al agregar el miembro",
    );
  } finally {
    addingMember = false;
  }
}

onMount(() => {
  loadMembers();
});
</script>

<PageTitle title="Negocios" />

<div class="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
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
								<div class="min-w-0">
									<p class="truncate text-base text-fg">{tenant.name}</p>
									<p class="font-mono text-sm text-fg-muted">{tenant.slug}</p>
								</div>
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
						<FormField label="Nombre" for="business-name">
							<Input id="business-name" bind:value={newName} placeholder="Bodega Los Andes" />
						</FormField>
						<FormField label="Slug" for="business-slug" class="mb-0!">
							<Input
								id="business-slug"
								bind:value={newSlug}
								placeholder="bodega-los-andes"
								class="font-mono"
								oninput={() => (slugTouched = true)}
							/>
							<p class="mt-1.5 text-sm text-fg-muted">
								Minúsculas, números y guiones. Identifica al negocio y no se puede cambiar.
							</p>
						</FormField>
					</div>
					<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
						<Button type="submit" disabled={creating || !newName || !newSlug}>
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
										<p class="font-mono text-sm text-fg-muted">@{member.username}</p>
									</div>
									<span class="text-sm text-fg-muted">{roleLabel(member.role)}</span>
								</li>
							{/each}
						</ul>
					{/if}

					<form class="border-t border-border-subtle" onsubmit={addMember}>
						<div class="p-4">
							<fieldset class="mb-4">
								<legend class="sr-only">Tipo de miembro</legend>
								<div class="inline-flex rounded-sm bg-sunken p-0.5">
									{@render modeOption("new", "Usuario nuevo")}
									{@render modeOption("existing", "Usuario existente")}
								</div>
							</fieldset>

							<div class="grid gap-x-4 md:grid-cols-2">
								<FormField label="Usuario" for="member-username">
									<Input id="member-username" bind:value={memberUsername} autocomplete="off" class="font-mono" />
								</FormField>
								<FormField label="Rol" for="member-role">
									<Select id="member-role" bind:value={memberRole} items={roleItems} />
								</FormField>
								{#if memberMode === "new"}
									<FormField label="Nombre" for="member-name">
										<Input id="member-name" bind:value={memberFullName} />
									</FormField>
									<FormField label="Contraseña" for="member-password">
										<Input id="member-password" type="password" bind:value={memberPassword} autocomplete="new-password" />
										<p class="mt-1.5 text-sm text-fg-muted">Mínimo {MIN_PASSWORD_LENGTH} caracteres.</p>
									</FormField>
								{/if}
							</div>
						</div>
						<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
							<Button
								type="submit"
								disabled={addingMember ||
									!memberUsername ||
									(memberMode === "new" && (!memberFullName || !memberPassword))}
							>
								{addingMember ? "Agregando…" : "Agregar miembro"}
							</Button>
						</footer>
					</form>
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
</div>

{#snippet modeOption(value: "new" | "existing", label: string)}
	<label
		class="flex h-7 cursor-pointer items-center rounded-[5px] px-3 text-sm transition-colors duration-150 ease-out has-checked:bg-surface has-checked:text-fg has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-ring {memberMode ===
		value
			? ''
			: 'text-fg-muted hover:text-fg'}"
	>
		<input type="radio" name="member-mode" {value} bind:group={memberMode} class="sr-only" />
		{label}
	</label>
{/snippet}
