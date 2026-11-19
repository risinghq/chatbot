<script lang="ts">
import { goto } from "$app/navigation";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import Button from "#lib/components/ui/button.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import PermissionMatrix from "#lib/components/admin/permission-matrix.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { roleLabels } from "#lib/utils/roles.js";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import NeedsTenant from "#lib/components/shared/needs-tenant.svelte";
import { MIN_PASSWORD_LENGTH } from "@vendeya/types";
import { PASSWORD_TOO_SHORT_MESSAGE } from "#lib/utils/password.js";

let { data } = $props();

let formData = $state({
  name: "",
  username: "",
  password: "",
  role: "sales_agent",
  phoneNumber: "",
});

let loading = $state(false);

async function handleSubmit() {
  if (!formData.name || !formData.username || !formData.password) {
    toast.error("Todos los campos marcados son obligatorios");
    return;
  }

  if (formData.password.length < MIN_PASSWORD_LENGTH) {
    toast.error(PASSWORD_TOO_SHORT_MESSAGE);
    return;
  }

  loading = true;
  try {
    await fetchApi("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });

    toast.success(`Usuario ${formData.username} creado correctamente`);
    goto("/dashboard/admin/users");
  } catch (error) {
    console.error(error);
    toast.error(
      "Error al crear usuario. Verifica que el nombre de usuario no exista.",
    );
  } finally {
    loading = false;
  }
}
</script>

<PageTitle title="Nuevo Usuario" />

{#if !data.user?.activeTenantId}
<NeedsTenant />
{:else}
<form
	class="max-w-2xl"
	onsubmit={(e) => {
		e.preventDefault();
		handleSubmit();
	}}
>
	<SectionShell title="Nuevo usuario" description="Crea el acceso inicial de un miembro del equipo.">
		<div class="p-4">
			<div class="grid grid-cols-1 gap-x-4 md:grid-cols-2">
				<FormField label="Nombre completo" for="name">
					<Input id="name" bind:value={formData.name} placeholder="Juan Pérez" />
				</FormField>
				<FormField label="Nombre de usuario" for="username">
					<Input id="username" bind:value={formData.username} placeholder="jperez" autocomplete="off" />
				</FormField>
			</div>

			<FormField label="Contraseña temporal" for="password">
				<Input id="password" type="password" bind:value={formData.password} autocomplete="new-password" />
				<p class="mt-1.5 text-sm text-fg-muted">
					Mínimo {MIN_PASSWORD_LENGTH} caracteres. El usuario la cambia en su primer acceso.
				</p>
			</FormField>

			<FormField label="Rol" for="role" class="mb-0!">
				<Select
					id="role"
					bind:value={formData.role}
					items={Object.entries(roleLabels).map(([value, label]) => ({ value, label }))}
				/>
			</FormField>
			<PermissionMatrix role={formData.role} />

			{#if formData.role === "sales_agent"}
				<FormField label="Teléfono (WhatsApp)" for="phoneNumber" class="mt-4 mb-0!">
					<Input id="phoneNumber" bind:value={formData.phoneNumber} placeholder="+51987654321" />
					<p class="mt-1.5 text-sm text-fg-muted">Se usa para asignarle conversaciones.</p>
				</FormField>
			{/if}
		</div>
		<footer class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
			<Button variant="ghost" href="/dashboard/admin/users">Cancelar</Button>
			<Button type="submit" disabled={loading}>
				{loading ? "Creando…" : "Crear usuario"}
			</Button>
		</footer>
	</SectionShell>
</form>
{/if}
