<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { auth } from "#lib/state/auth.svelte.js";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Button from "#lib/components/ui/button.svelte";
import { fetchApi } from "#lib/utils/api.js";
import PageTitle from "#lib/components/shared/page-title.svelte";

let username = $state("");
let password = $state("");
let error = $state("");
let loading = $state(false);

async function handleSubmit() {
  if (!(username && password)) {
    error = "Usuario y contraseña son requeridos";
    return;
  }

  loading = true;
  error = "";

  try {
    const data = await fetchApi<{ user: any }>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    auth.hydrate(data.user);
    goto("/dashboard");
  } catch {
    error = "Credenciales no válidas";
  } finally {
    loading = false;
  }
}

onMount(() => {
  if (auth.isAuthenticated) {
    goto("/dashboard");
  }
});
</script>

<PageTitle title="Iniciar sesión" />

<div class="flex min-h-dvh flex-col items-center justify-center bg-canvas p-4">
	<div class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 shadow-sm">
		<h1 class="text-lg font-medium text-fg">vendeya</h1>
		<p class="mt-1 mb-6 text-base text-fg-muted">Entra con la cuenta que te dio tu negocio.</p>

		<form
			onsubmit={(e) => {
				e.preventDefault();
				handleSubmit();
			}}
		>
			<FormField label="Identificador" for="username">
				<Input
					id="username"
					autocomplete="username"
					bind:value={username}
					disabled={loading}
					placeholder="agente_01"
				/>
			</FormField>

			<FormField label="Clave de acceso" for="password">
				<Input
					id="password"
					type="password"
					autocomplete="current-password"
					bind:value={password}
					disabled={loading}
				/>
			</FormField>

			{#if error}
				<p role="alert" class="mb-4 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>
			{/if}

			<Button type="submit" disabled={loading} class="w-full">
				{loading ? "Verificando…" : "Acceder"}
			</Button>
		</form>
	</div>
</div>
