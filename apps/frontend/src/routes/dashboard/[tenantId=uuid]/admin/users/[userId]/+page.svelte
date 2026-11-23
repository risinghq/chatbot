<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import { onMount } from "svelte";
import { page } from "$app/state";
import { goto } from "$app/navigation";
import { fetchApi } from "#lib/utils/api.js";
import { MIN_PASSWORD_LENGTH } from "@vendeya/types";
import { PASSWORD_TOO_SHORT_MESSAGE } from "#lib/utils/password.js";
import { toast } from "#lib/state/toast.svelte.js";
import { auth } from "#lib/state/auth.svelte.js";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Select from "#lib/components/ui/select.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import PermissionMatrix from "#lib/components/admin/permission-matrix.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { roleLabels } from "#lib/utils/roles.js";

let user = $state<any>(null);
let originalRole = $state<string>("");
let saving = $state(false);

const userId = page.params.userId;

// A platform operator's account reaches every business, so the API lets only
// another platform operator deactivate it or reset its password.
const accountLocked = $derived(
  user?.is_platform_operator === 1 && !auth.isPlatformOperator,
);

async function loadUser() {
  try {
    const res = await fetchApi<{ users: any[] }>("/api/admin/users");
    user = res.users.find((u) => u.id === userId);
    if (user) {
      originalRole = user.role;
    }
  } catch (e) {
    console.error(e);
    toast.error("Error al cargar usuario");
  }
}

async function saveChanges() {
  if (!user) return;

  // Only save if role changed
  if (user.role === originalRole) {
    toast.info("No hay cambios para guardar");
    return;
  }

  saving = true;
  try {
    await fetchApi(`/api/admin/users/${user.id}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: user.role }),
    });
    originalRole = user.role;
    toast.success("Rol actualizado correctamente");
    goto(businessPath("/admin/users"));
  } catch (e) {
    toast.error("Error al actualizar rol");
  } finally {
    saving = false;
  }
}

async function toggleStatus() {
  if (!user) return;
  try {
    await fetchApi(`/api/admin/users/${user.id}/status`, { method: "PATCH" });
    user.is_active = user.is_active === 1 ? 0 : 1;
    toast.success(`Usuario ${user.is_active ? "activado" : "desactivado"}`);
  } catch (e) {
    toast.error("Error al cambiar estado");
  }
}

let newPassword = $state("");

async function resetPassword() {
  const newPass = newPassword;
  if (newPass.length < MIN_PASSWORD_LENGTH) {
    toast.error(PASSWORD_TOO_SHORT_MESSAGE);
    return;
  }

  try {
    await fetchApi(`/api/admin/users/${user.id}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: newPass }),
    });
    newPassword = "";
    toast.success("Contraseña actualizada");
  } catch (e) {
    toast.error("Error al actualizar contraseña");
  }
}

onMount(() => {
  loadUser();
});
</script>

<PageTitle title={user ? `Editar ${user.name}` : "Cargando..."} />

<div class="flex max-w-3xl flex-col gap-6">
	<a href="{businessPath()}/admin/users" class="self-start text-sm text-fg-muted hover:text-fg">← Usuarios</a>

	{#if user}
		<header class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<h2 class="text-lg text-fg">{user.name}</h2>
				<p class="mt-0.5 text-sm text-fg-muted">{user.email}</p>
			</div>
			<Badge variant={user.is_active ? "success" : "default"}>
				{user.is_active ? "Activo" : "Inactivo"}
			</Badge>
		</header>

		<SectionShell title="Rol y permisos" description="Un cambio de rol cambia sus accesos en cuanto guardas.">
			<div class="p-4">
				<FormField label="Rol" for="role" class="mb-0!">
					<Select
						id="role"
						bind:value={user.role}
						items={Object.entries(roleLabels).map(([value, label]) => ({ value, label }))}
					/>
				</FormField>
				<PermissionMatrix role={user.role} />
			</div>
			<footer class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
				<Button variant="ghost" href="{businessPath()}/admin/users">Cancelar</Button>
				<Button onclick={saveChanges} disabled={saving}>
					{saving ? "Guardando…" : "Guardar cambios"}
				</Button>
			</footer>
		</SectionShell>

		<SectionShell title="Seguridad y acceso">
			{#if accountLocked}
				<p class="p-4 text-base text-fg-muted">
					Esta cuenta pertenece al equipo de VendeYa. Solo ese equipo puede desactivarla o restablecer su contraseña.
				</p>
			{:else}
				<div class="divide-y divide-border-subtle">
					<div class="flex items-center justify-between gap-4 p-4">
						<div>
							<p class="text-base font-medium text-fg">Estado de la cuenta</p>
							<p class="text-sm text-fg-muted">Una cuenta desactivada no puede entrar.</p>
						</div>
						<Button size="sm" variant={user.is_active ? "danger" : "secondary"} onclick={toggleStatus}>
							{user.is_active ? "Desactivar" : "Activar"}
						</Button>
					</div>
					<form
						class="p-4"
						onsubmit={(e) => {
							e.preventDefault();
							resetPassword();
						}}
					>
						<FormField label="Nueva contraseña" for="new-password" class="mb-0!">
							<div class="flex gap-2">
								<Input id="new-password" type="password" bind:value={newPassword} autocomplete="new-password" />
								<Button type="submit" variant="secondary" disabled={!newPassword}>Restablecer</Button>
							</div>
							<p class="mt-1.5 text-sm text-fg-muted">Mínimo {MIN_PASSWORD_LENGTH} caracteres.</p>
						</FormField>
					</form>
				</div>
			{/if}
		</SectionShell>
	{:else}
		<div class="h-12 w-1/3 animate-pulse rounded-sm bg-sunken" aria-busy="true"></div>
	{/if}
</div>
