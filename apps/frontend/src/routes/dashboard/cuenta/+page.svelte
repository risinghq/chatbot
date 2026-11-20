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

type ApiToken = {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
};

let tokens = $state<ApiToken[]>([]);
let tokenName = $state("");
let creatingToken = $state(false);
/** The plain token, shown once right after it is created. */
let newToken = $state<string | null>(null);

const dateFormat = new Intl.DateTimeFormat("es-PE", { dateStyle: "medium" });

onMount(async () => {
  const [{ user }, list] = await Promise.all([
    fetchApi<{
      user: { email: string; name: string; phoneNumber: string | null };
    }>("/api/auth/me"),
    fetchApi<ApiToken[]>("/api/auth/tokens"),
  ]);
  email = user.email;
  name = user.name;
  phoneNumber = user.phoneNumber ?? "";
  tokens = list;
});

async function createToken(e: Event) {
  e.preventDefault();
  creatingToken = true;
  try {
    const created = await fetchApi<ApiToken & { token: string }>(
      "/api/auth/tokens",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tokenName }),
      },
    );
    const { token, ...listed } = created;
    tokens = [listed, ...tokens];
    newToken = token;
    tokenName = "";
  } catch {
    toast.error("No se pudo crear el token");
  } finally {
    creatingToken = false;
  }
}

async function copyToken() {
  if (!newToken) return;
  await navigator.clipboard.writeText(newToken);
  toast.success("Token copiado");
}

async function revokeToken(token: ApiToken) {
  if (
    !confirm(
      `¿Revocar el token «${token.name}»? Deja de funcionar al instante.`,
    )
  )
    return;
  try {
    await fetchApi(`/api/auth/tokens/${token.id}`, { method: "DELETE" });
    tokens = tokens.filter((t) => t.id !== token.id);
    toast.success("Token revocado");
  } catch {
    toast.error("No se pudo revocar el token");
  }
}

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

		<SectionShell
			title="Tokens de acceso"
			description="Un token deja que un agente o un script use la CLI vendeya con tus permisos, en el negocio abierto ahora."
		>
			<form onsubmit={createToken} class="flex items-end gap-2 p-4">
				<FormField label="Nombre del token" for="token-name" class="mb-0! flex-1">
					<Input id="token-name" bind:value={tokenName} placeholder="agente de ventas" />
				</FormField>
				<Button type="submit" disabled={creatingToken || !tokenName.trim()}>
					{creatingToken ? "Creando…" : "Crear token"}
				</Button>
			</form>

			{#if newToken}
				<div class="border-t border-border-subtle px-4 py-3">
					<p class="mb-2 text-sm text-fg-muted">Cópialo ahora: no se vuelve a mostrar.</p>
					<div class="flex items-center gap-2">
						<code class="min-w-0 flex-1 truncate rounded-md bg-sunken px-2 py-1.5 font-mono text-sm">{newToken}</code>
						<Button variant="secondary" size="sm" onclick={copyToken}>Copiar</Button>
						<Button variant="ghost" size="sm" onclick={() => (newToken = null)}>Listo</Button>
					</div>
				</div>
			{/if}

			{#if tokens.length > 0}
				<ul class="border-t border-border-subtle">
					{#each tokens as token (token.id)}
						<li class="flex items-center gap-3 border-b border-border-subtle px-4 py-2.5 last:border-b-0">
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{token.name}</p>
								<p class="text-xs text-fg-muted">
									Creado {dateFormat.format(token.created_at)} ·
									{token.last_used_at ? `usado ${dateFormat.format(token.last_used_at)}` : "sin usar"} ·
									vence {dateFormat.format(token.expires_at)}
								</p>
							</div>
							<Button variant="ghost" size="sm" onclick={() => revokeToken(token)}>Revocar</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</SectionShell>
	</div>
</div>
