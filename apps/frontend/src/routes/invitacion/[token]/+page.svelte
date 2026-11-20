<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { MIN_PASSWORD_LENGTH } from "@vendeya/types";
import { auth } from "#lib/state/auth.svelte.js";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Button from "#lib/components/ui/button.svelte";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { PASSWORD_TOO_SHORT_MESSAGE } from "#lib/utils/password.js";
import { roleLabel } from "#lib/utils/roles.js";
import PageTitle from "#lib/components/shared/page-title.svelte";

type Preview = {
  tenantName: string;
  email: string;
  role: string;
  hasAccount: boolean;
};

const token = page.params.token ?? "";
let preview = $state<Preview | null>(null);
let invalid = $state(false);

let name = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);

onMount(async () => {
  try {
    preview = await fetchApi<Preview>(
      `/api/auth/invitations/${encodeURIComponent(token)}`,
    );
  } catch {
    invalid = true;
  }
});

async function accept(e: Event) {
  e.preventDefault();
  if (!preview) return;
  if (!preview.hasAccount && password.length < MIN_PASSWORD_LENGTH) {
    error = PASSWORD_TOO_SHORT_MESSAGE;
    return;
  }

  loading = true;
  error = "";
  try {
    const data = await fetchApi<{ user: any }>(
      `/api/auth/invitations/${encodeURIComponent(token)}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          preview.hasAccount ? { password } : { name, password },
        ),
      },
    );
    auth.hydrate(data.user);
    goto("/dashboard");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      invalid = true;
    } else if (err instanceof ApiError && err.status === 401) {
      error = "La contraseña no es correcta";
    } else if (err instanceof ApiError && err.status === 403) {
      error = "Tu cuenta está desactivada";
    } else {
      error = "No se pudo aceptar la invitación";
    }
  } finally {
    loading = false;
  }
}
</script>

<PageTitle title="Invitación" />

<div class="flex min-h-dvh flex-col items-center justify-center bg-canvas p-4">
	<div class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
		{#if invalid}
			<h1 class="text-lg font-medium text-fg">Este enlace no sirve</h1>
			<p class="mt-1 text-base text-fg-muted">
				Ya se usó, venció o fue anulado. Pide un enlace nuevo a quien te invitó.
			</p>
			<p class="mt-6 text-sm"><a href="/login" class="text-fg underline underline-offset-2">Iniciar sesión</a></p>
		{:else if !preview}
			<div class="h-24 animate-pulse rounded-sm bg-sunken" aria-busy="true"></div>
		{:else}
			<h1 class="text-lg font-medium text-fg">Únete a {preview.tenantName}</h1>
			<p class="mt-1 mb-6 text-base text-fg-muted">
				Te invitaron como {roleLabel(preview.role).toLowerCase()} con el correo {preview.email}.
				{preview.hasAccount ? "Confirma con la contraseña de tu cuenta." : "Elige tu nombre y una contraseña."}
			</p>

			<form onsubmit={accept}>
				{#if !preview.hasAccount}
					<FormField label="Tu nombre" for="name">
						<Input id="name" bind:value={name} autocomplete="name" disabled={loading} />
					</FormField>
				{/if}
				<FormField label="Contraseña" for="password">
					<Input
						id="password"
						type="password"
						bind:value={password}
						autocomplete={preview.hasAccount ? "current-password" : "new-password"}
						disabled={loading}
					/>
					{#if !preview.hasAccount}
						<p class="mt-1.5 text-sm text-fg-muted">Mínimo {MIN_PASSWORD_LENGTH} caracteres.</p>
					{/if}
				</FormField>

				{#if error}
					<p role="alert" class="mb-4 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>
				{/if}

				<Button
					type="submit"
					disabled={loading || !password || (!preview.hasAccount && !name.trim())}
					class="w-full"
				>
					{loading ? "Uniéndote…" : "Unirme"}
				</Button>
			</form>
		{/if}
	</div>
</div>
