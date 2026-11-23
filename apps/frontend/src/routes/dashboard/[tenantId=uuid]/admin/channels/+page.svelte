<script lang="ts">
import { onMount } from "svelte";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import { auth } from "#lib/state/auth.svelte.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";

type ChannelAccount = {
  id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  label: string | null;
  status: string;
  has_access_token: boolean;
  has_app_secret: boolean;
  verify_token: string | null;
  webhook_url: string;
};

let accounts = $state<ChannelAccount[]>([]);
let loading = $state(true);
let saving = $state<string | null>(null);

// Write-only credential fields, per account id.
let accessTokens = $state<Record<string, string>>({});
let appSecrets = $state<Record<string, string>>({});
let verifyTokens = $state<Record<string, string>>({});

const emptyDraft = {
  phoneNumberId: "",
  displayPhoneNumber: "",
  label: "",
  wabaId: "",
  accessToken: "",
  appSecret: "",
};
let draft = $state({ ...emptyDraft });
let adding = $state(false);
let creating = $state(false);

const statusLabels: Record<string, string> = {
  active: "Activo",
  pending: "Pendiente",
  disabled: "Deshabilitado",
};

const statusVariants: Record<string, "success" | "warning" | "default"> = {
  active: "success",
  pending: "warning",
  disabled: "default",
};

async function load() {
  loading = true;
  try {
    const res = await fetchApi<{ accounts: ChannelAccount[] }>(
      "/api/admin/channels",
    );
    accounts = res.accounts;
  } catch (e) {
    console.error(e);
  } finally {
    loading = false;
  }
}

async function create() {
  if (!draft.phoneNumberId.trim()) {
    toast.error("El phone number id es obligatorio");
    return;
  }
  // Empty optional fields go as absent, which the API reads as unset.
  const body = Object.fromEntries(
    Object.entries(draft)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value !== ""),
  );
  creating = true;
  try {
    await fetchApi("/api/admin/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    draft = { ...emptyDraft };
    adding = false;
    toast.success("Número agregado");
    await load();
  } catch (e) {
    toast.error(
      e instanceof ApiError && e.status === 409
        ? "Ese phone number id ya está registrado"
        : "Error al agregar el número",
    );
  } finally {
    creating = false;
  }
}

async function save(account: ChannelAccount) {
  const body: Record<string, string> = {};
  const accessToken = accessTokens[account.id];
  const appSecret = appSecrets[account.id];
  const verifyToken = verifyTokens[account.id];
  if (accessToken) body.accessToken = accessToken;
  if (appSecret) body.appSecret = appSecret;
  if (verifyToken) body.verifyToken = verifyToken;
  if (Object.keys(body).length === 0) return;

  saving = account.id;
  try {
    await fetchApi(`/api/admin/channels/${account.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    accessTokens[account.id] = "";
    appSecrets[account.id] = "";
    verifyTokens[account.id] = "";
    toast.success("Credenciales actualizadas");
    await load();
  } catch (e) {
    toast.error("Error al guardar las credenciales");
  } finally {
    saving = null;
  }
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copiado");
  } catch {
    toast.error("No se pudo copiar");
  }
}

function secretPlaceholder(stored: boolean) {
  return stored ? "Configurado; escribe para reemplazarlo" : "Sin configurar";
}

onMount(() => {
  load();
});
</script>

<div class="flex flex-col gap-6">
	<SectionShell
		title="Números de WhatsApp"
		description="El token de acceso y el app secret de Meta se guardan cifrados. Copia la URL del webhook y el token de verificación en la configuración del webhook de tu app de Meta."
		action={auth.isPlatformOperator && accounts.length > 0 && !adding ? addAction : undefined}
	>
		{#if loading}
			<div class="flex flex-col gap-3 p-4" aria-busy="true">
				<div class="h-8 animate-pulse rounded-sm bg-sunken"></div>
				<div class="h-8 animate-pulse rounded-sm bg-sunken"></div>
			</div>
		{:else if accounts.length === 0 && !adding}
			<EmptyState
				title="Sin números conectados"
				description={auth.isPlatformOperator
					? "Agrega el número de WhatsApp Business del negocio con su phone number id de Meta."
					: "El equipo de VendeYa conecta el número de tu negocio. Escríbeles para empezar."}
			>
				{#snippet action()}
					{#if auth.isPlatformOperator}
						<Button onclick={() => (adding = true)}>Agregar número</Button>
					{/if}
				{/snippet}
			</EmptyState>
		{:else}
			<ul class="divide-y divide-border-subtle">
				{#each accounts as account (account.id)}
					<li>{@render accountRow(account)}</li>
				{/each}
			</ul>
		{/if}
	</SectionShell>

	{#if adding}
		{@render createForm()}
	{/if}
</div>

{#snippet addAction()}
	<Button size="sm" variant="secondary" onclick={() => (adding = true)}>Agregar número</Button>
{/snippet}

{#snippet accountRow(account: ChannelAccount)}
	<div class="flex flex-col gap-4 p-4">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<p class="text-base font-medium text-fg">
					{account.label || account.display_phone_number || account.phone_number_id}
				</p>
				<p class="mt-0.5 font-mono text-sm text-fg-muted">
					{#if account.display_phone_number}{account.display_phone_number} · {/if}{account.phone_number_id}
				</p>
			</div>
			<Badge variant={statusVariants[account.status] ?? "default"}>
				{statusLabels[account.status] ?? account.status}
			</Badge>
		</div>

		<dl class="grid gap-3 md:grid-cols-2">
			{@render copyable("URL del webhook", account.webhook_url)}
			{@render copyable("Token de verificación", account.verify_token)}
		</dl>

		<div class="grid gap-x-4 md:grid-cols-2">
			<FormField label="Token de acceso" for="at-{account.id}">
				<Input
					id="at-{account.id}"
					type="password"
					bind:value={accessTokens[account.id]}
					placeholder={secretPlaceholder(account.has_access_token)}
				/>
			</FormField>
			<FormField label="App secret de Meta" for="as-{account.id}">
				<Input
					id="as-{account.id}"
					type="password"
					bind:value={appSecrets[account.id]}
					placeholder={secretPlaceholder(account.has_app_secret)}
				/>
			</FormField>
			{#if auth.isPlatformOperator}
				<FormField label="Reemplazar token de verificación" for="vt-{account.id}" class="md:col-span-2">
					<Input
						id="vt-{account.id}"
						type="password"
						bind:value={verifyTokens[account.id]}
						placeholder="Vacío conserva el generado"
					/>
				</FormField>
			{/if}
		</div>

		<div class="flex justify-end">
			<Button
				size="sm"
				disabled={saving === account.id ||
					(!accessTokens[account.id] && !appSecrets[account.id] && !verifyTokens[account.id])}
				onclick={() => save(account)}
			>
				{saving === account.id ? "Guardando…" : "Guardar credenciales"}
			</Button>
		</div>
	</div>
{/snippet}

{#snippet copyable(label: string, value: string | null)}
	<div class="min-w-0">
		<dt class="mb-1 text-sm text-fg-muted">{label}</dt>
		<dd class="flex items-center gap-1 rounded-sm border border-border-subtle bg-sunken py-0.5 pr-0.5 pl-2.5">
			<code class="min-w-0 flex-1 truncate font-mono text-sm text-fg" title={value ?? undefined}>{value ?? "—"}</code>
			{#if value}
				<Button size="sm" variant="ghost" onclick={() => copy(value)} aria-label="Copiar {label}">Copiar</Button>
			{/if}
		</dd>
	</div>
{/snippet}

{#snippet createForm()}
	<form
		onsubmit={(e) => {
			e.preventDefault();
			create();
		}}
	>
		<SectionShell
			title="Agregar número"
			description="Los datos están en Meta, en WhatsApp › Configuración de la API de tu app. El número queda pendiente hasta que tenga token de acceso."
		>
			<div class="grid gap-x-4 p-4 md:grid-cols-2">
				<FormField label="Phone number id" for="new-pnid">
					<Input id="new-pnid" bind:value={draft.phoneNumberId} placeholder="123456789012345" class="font-mono" />
				</FormField>
				<FormField label="Número visible" for="new-display">
					<Input id="new-display" bind:value={draft.displayPhoneNumber} placeholder="+51 987 654 321" />
				</FormField>
				<FormField label="Nombre interno" for="new-label">
					<Input id="new-label" bind:value={draft.label} placeholder="Ventas Lima" />
				</FormField>
				<FormField label="WhatsApp Business Account id" for="new-waba">
					<Input id="new-waba" bind:value={draft.wabaId} placeholder="Opcional" class="font-mono" />
				</FormField>
				<FormField label="Token de acceso" for="new-at">
					<Input id="new-at" type="password" bind:value={draft.accessToken} autocomplete="off" />
				</FormField>
				<FormField label="App secret de Meta" for="new-as">
					<Input id="new-as" type="password" bind:value={draft.appSecret} autocomplete="off" />
				</FormField>
			</div>
			<footer class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
				<Button variant="ghost" onclick={() => (adding = false)}>Cancelar</Button>
				<Button type="submit" disabled={creating || !draft.phoneNumberId.trim()}>
					{creating ? "Agregando…" : "Agregar número"}
				</Button>
			</footer>
		</SectionShell>
	</form>
{/snippet}
