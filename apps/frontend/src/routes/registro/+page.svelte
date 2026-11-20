<script lang="ts">
import { goto } from "$app/navigation";
import { MIN_PASSWORD_LENGTH } from "@vendeya/types";
import { auth } from "#lib/state/auth.svelte.js";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Button from "#lib/components/ui/button.svelte";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { PASSWORD_TOO_SHORT_MESSAGE } from "#lib/utils/password.js";
import PageTitle from "#lib/components/shared/page-title.svelte";

let businessName = $state("");
let name = $state("");
let email = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);

async function handleSubmit(e: Event) {
  e.preventDefault();
  if (password.length < MIN_PASSWORD_LENGTH) {
    error = PASSWORD_TOO_SHORT_MESSAGE;
    return;
  }

  loading = true;
  error = "";
  try {
    const data = await fetchApi<{ user: any }>("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName, name, email, password }),
    });
    auth.hydrate(data.user);
    goto("/dashboard");
  } catch (err) {
    error =
      err instanceof ApiError && err.status === 409
        ? "Ya hay una cuenta con ese correo. Inicia sesión."
        : err instanceof ApiError && err.status === 429
          ? "Demasiados intentos. Espera un minuto."
          : "Revisa los datos: el correo debe ser válido y todos los campos son requeridos.";
  } finally {
    loading = false;
  }
}
</script>

<PageTitle title="Crear cuenta" />

<div class="flex min-h-dvh flex-col items-center justify-center bg-canvas p-4">
	<div class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
		<h1 class="text-lg font-medium text-fg">Crea tu negocio en vendeya</h1>
		<p class="mt-1 mb-6 text-base text-fg-muted">Quedas como administrador y luego invitas a tu equipo.</p>

		<form onsubmit={handleSubmit}>
			<FormField label="Nombre del negocio" for="business-name">
				<Input id="business-name" bind:value={businessName} autocomplete="organization" disabled={loading} />
			</FormField>
			<FormField label="Tu nombre" for="name">
				<Input id="name" bind:value={name} autocomplete="name" disabled={loading} />
			</FormField>
			<FormField label="Correo" for="email">
				<Input id="email" type="email" bind:value={email} autocomplete="email" disabled={loading} />
			</FormField>
			<FormField label="Contraseña" for="password">
				<Input id="password" type="password" bind:value={password} autocomplete="new-password" disabled={loading} />
				<p class="mt-1.5 text-sm text-fg-muted">Mínimo {MIN_PASSWORD_LENGTH} caracteres.</p>
			</FormField>

			{#if error}
				<p role="alert" class="mb-4 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>
			{/if}

			<Button
				type="submit"
				disabled={loading || !(businessName.trim() && name.trim() && email.trim() && password)}
				class="w-full"
			>
				{loading ? "Creando…" : "Crear cuenta"}
			</Button>
		</form>

		<p class="mt-6 text-sm text-fg-muted">
			¿Ya tienes cuenta? <a href="/login" class="text-fg underline underline-offset-2">Inicia sesión</a>
		</p>
	</div>
</div>
