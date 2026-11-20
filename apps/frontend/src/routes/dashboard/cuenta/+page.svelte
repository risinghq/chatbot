<script lang="ts">
import { onMount } from "svelte";
import { MIN_PASSWORD_LENGTH } from "@vendeya/types";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import { PASSWORD_TOO_SHORT_MESSAGE } from "#lib/utils/password.js";

let email = $state("");
let name = $state("");
let phoneNumber = $state("");
let savingProfile = $state(false);

let currentPassword = $state("");
let newPassword = $state("");
let passwordError = $state("");
let savingPassword = $state(false);

onMount(async () => {
  const { user } = await fetchApi<{
    user: { email: string; name: string; phoneNumber: string | null };
  }>("/api/auth/me");
  email = user.email;
  name = user.name;
  phoneNumber = user.phoneNumber ?? "";
});

async function saveProfile(e: Event) {
  e.preventDefault();
  savingProfile = true;
  try {
    const saved = await fetchApi<{ name: string; phoneNumber: string | null }>(
      "/api/auth/me",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phoneNumber }),
      },
    );
    name = saved.name;
    phoneNumber = saved.phoneNumber ?? "";
    if (auth.user) auth.user.name = saved.name;
    toast.success("Datos guardados");
  } catch {
    toast.error("No se pudieron guardar tus datos");
  } finally {
    savingProfile = false;
  }
}

async function changePassword(e: Event) {
  e.preventDefault();
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    passwordError = PASSWORD_TOO_SHORT_MESSAGE;
    return;
  }
  passwordError = "";
  savingPassword = true;
  try {
    await fetchApi("/api/auth/me/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    currentPassword = "";
    newPassword = "";
    toast.success("Contraseña cambiada. Las demás sesiones se cerraron.");
  } catch {
    passwordError = "La contraseña actual no es correcta";
  } finally {
    savingPassword = false;
  }
}
</script>

<PageTitle title="Mi cuenta" />

<div class="mx-auto max-w-2xl px-4 py-6 md:px-8 md:py-8">
	<PageHeader title="Mi cuenta" subtitle={email} />

	<div class="flex flex-col gap-6">
		<form onsubmit={saveProfile}>
			<SectionShell title="Tus datos" description="El teléfono recibe los avisos de las conversaciones que te asignan.">
				<div class="p-4">
					<FormField label="Nombre" for="name">
						<Input id="name" bind:value={name} autocomplete="name" />
					</FormField>
					<FormField label="Teléfono (WhatsApp)" for="phone" class="mb-0!">
						<Input id="phone" bind:value={phoneNumber} autocomplete="tel" placeholder="51987654321" class="font-mono tabular-nums" />
					</FormField>
				</div>
				<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
					<Button type="submit" disabled={savingProfile || !name.trim()}>
						{savingProfile ? "Guardando…" : "Guardar"}
					</Button>
				</footer>
			</SectionShell>
		</form>

		<form onsubmit={changePassword}>
			<SectionShell title="Contraseña" description="Al cambiarla se cierran tus sesiones en otros dispositivos.">
				<div class="p-4">
					<FormField label="Contraseña actual" for="current-password">
						<Input id="current-password" type="password" bind:value={currentPassword} autocomplete="current-password" />
					</FormField>
					<FormField label="Nueva contraseña" for="new-password" error={passwordError || undefined} class="mb-0!">
						<Input id="new-password" type="password" bind:value={newPassword} autocomplete="new-password" />
						<p class="mt-1.5 text-sm text-fg-muted">Mínimo {MIN_PASSWORD_LENGTH} caracteres.</p>
					</FormField>
				</div>
				<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
					<Button type="submit" disabled={savingPassword || !currentPassword || !newPassword}>
						{savingPassword ? "Cambiando…" : "Cambiar contraseña"}
					</Button>
				</footer>
			</SectionShell>
		</form>
	</div>
</div>
