<script lang="ts">
import { onMount } from "svelte";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import Banner from "#lib/components/ui/banner.svelte";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";

let settings = $state<Record<string, string>>({});
let initialSettings = $state<Record<string, string>>({});
let loading = $state(true);
let saving = $state(false);

// The Cálidda password and the OpenAI key are write-only: the API reports
// `_has_<key>`, never the value. Each field stays out of `settings` so a save
// posts it only when the admin typed a new one.
let caliddaPassword = $state("");
let openaiKey = $state("");

const hasChanges = $derived(
  JSON.stringify(settings) !== JSON.stringify(initialSettings) ||
    caliddaPassword !== "" ||
    openaiKey !== "",
);

// The provider switches are platform settings, edited on /dashboard/ajustes.
// The API reports them here as `_platform_<key>`, which a save never posts
// back, so a business sees their state read-only.
function platformSwitchOn(key: string): boolean {
  return settings[`_platform_${key}`] === "true";
}

function secretPlaceholder(stored: string | undefined): string {
  return stored === "true"
    ? "Configurada; escribe para reemplazarla"
    : "Sin configurar";
}

async function loadSettings() {
  loading = true;
  try {
    const data = await fetchApi<Record<string, string>>("/api/admin/settings");
    settings = { ...data };
    initialSettings = { ...data };
  } catch (e) {
    console.error(e);
  } finally {
    loading = false;
  }
}

function discard() {
  settings = { ...initialSettings };
  caliddaPassword = "";
  openaiKey = "";
}

async function save() {
  saving = true;
  try {
    // Only the writable keys go back. The underscore-prefixed ones are the
    // server's read-only commentary: the platform values and the scope.
    const payload = Object.fromEntries(
      Object.entries(settings).filter(([key]) => !key.startsWith("_")),
    );
    if (caliddaPassword) payload.calidda_password = caliddaPassword;
    if (openaiKey) payload.openai_api_key = openaiKey;

    await fetchApi("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (caliddaPassword) settings._has_calidda_password = "true";
    if (openaiKey) settings._has_openai_api_key = "true";
    initialSettings = { ...settings };
    caliddaPassword = "";
    openaiKey = "";
    toast.success("Configuración guardada");
  } catch (e) {
    toast.error(
      e instanceof ApiError ? e.message : "Error al guardar la configuración",
    );
  } finally {
    saving = false;
  }
}

onMount(loadSettings);
</script>

{#if loading}
	<div class="flex flex-col gap-3" aria-busy="true">
		<div class="h-32 animate-pulse rounded-md bg-sunken"></div>
		<div class="h-32 animate-pulse rounded-md bg-sunken"></div>
	</div>
{:else}
	<form
		class="flex flex-col gap-6"
		onsubmit={(e) => {
			e.preventDefault();
			save();
		}}
	>
		<SectionShell
				title="OpenAI"
				description="La clave de API de OpenAI de este negocio. El asistente la usa para responder a los clientes."
			>
				<div class="p-4">
					{#if settings._has_openai_api_key !== "true"}
						<Banner tone="warning" class="mb-4">
							Sin clave, el asistente no responde: cada conversación pasa a una persona.
						</Banner>
					{/if}
					<FormField label="Clave de API" for="openai-api-key" class="mb-0!">
						<Input
							id="openai-api-key"
							type="password"
							bind:value={openaiKey}
							autocomplete="off"
							placeholder={secretPlaceholder(settings._has_openai_api_key)}
						/>
						<p class="mt-1.5 text-sm text-fg-muted">Se guarda cifrada y no se vuelve a mostrar.</p>
					</FormField>
				</div>
			</SectionShell>

			<SectionShell
				title="Cálidda (FNB)"
				description="La cuenta de Cálidda de este negocio. Con ella se verifica si un cliente tiene crédito."
			>
				<div class="grid gap-x-4 p-4 md:grid-cols-2">
					<FormField label="Usuario" for="calidda-username" class="md:mb-0!">
						<Input id="calidda-username" bind:value={settings.calidda_username} autocomplete="off" />
					</FormField>
					<FormField label="Contraseña" for="calidda-password" class="mb-0!">
						<Input
							id="calidda-password"
							type="password"
							bind:value={caliddaPassword}
							autocomplete="off"
							placeholder={secretPlaceholder(settings._has_calidda_password)}
						/>
					</FormField>
				</div>
			</SectionShell>

		<SectionShell
			title="Proveedores de crédito"
			description="El equipo de VendeYa los suspende cuando fallan. Aquí ves su estado."
		>
			<div class="divide-y divide-border-subtle">
				{@render providerSwitch(
					"force_fnb_down",
					"Suspender FNB (Cálidda)",
					"La verificación de elegibilidad deja de consultar a Cálidda.",
				)}
				{@render providerSwitch(
					"force_gaso_down",
					"Suspender GASO (Power BI)",
					"La verificación deja de consultar el reporte de Power BI.",
				)}
			</div>
		</SectionShell>

		{#if hasChanges}
			<div
				class="sticky bottom-4 flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-4 py-3 shadow-md"
			>
				<p class="text-sm text-fg-muted">Tienes cambios sin guardar.</p>
				<div class="flex gap-2">
					<Button variant="ghost" onclick={discard}>Descartar</Button>
					<Button type="submit" disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Button>
				</div>
			</div>
		{/if}
	</form>
{/if}

{#snippet providerSwitch(key: string, label: string, description: string)}
	<label class="flex items-start gap-3 px-4 py-3">
		<input
			type="checkbox"
			checked={platformSwitchOn(key)}
			disabled
			class="mt-1 size-4 rounded-sm border-border bg-surface text-accent disabled:cursor-not-allowed"
		/>
		<span class="min-w-0">
			<span class="block text-base text-fg">{label}</span>
			<span class="block text-sm text-fg-muted">{description}</span>
		</span>
	</label>
{/snippet}
