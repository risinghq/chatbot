<script lang="ts">
import { onMount } from "svelte";
import { fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import { auth } from "#lib/state/auth.svelte.js";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import NeedsTenant from "#lib/components/shared/needs-tenant.svelte";

let { data } = $props();

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

const statusLabels: Record<string, string> = {
  active: "Activo",
  pending: "Pendiente",
  disabled: "Deshabilitado",
};

onMount(load);
</script>

{#if !data.user?.activeTenantId}
  <NeedsTenant />
{:else}
<SectionShell
  title="Números de WhatsApp"
  description="Cada número guarda su token de acceso y el app secret de Meta cifrados. El token de verificación lo genera el sistema: cópialo en la consola de Meta junto con la URL del webhook."
>
  {#if loading}
    <div class="p-8 space-y-4 animate-pulse">
      <div class="h-10 bg-cream-50 rounded w-full"></div>
      <div class="h-10 bg-cream-50 rounded w-full"></div>
    </div>
  {:else if accounts.length === 0}
    <div class="p-8 text-sm text-ink-500">
      No hay números registrados. Un operador de la plataforma los da de alta
      con <code>account channel create</code>.
    </div>
  {:else}
    <div class="divide-y divide-ink-100/50">
      {#each accounts as account (account.id)}
        <div class="p-6 space-y-4">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="font-medium text-sm text-ink-900">
                {account.label || account.display_phone_number || account.id}
              </div>
              <div class="text-xs text-ink-500 mt-0.5">
                {account.display_phone_number ?? ""} ·
                {account.phone_number_id}
              </div>
            </div>
            <span
              class="text-xs font-bold uppercase tracking-wider {account.status ===
              'active'
                ? 'text-green-700'
                : 'text-orange-700'}"
            >
              {statusLabels[account.status] ?? account.status}
            </span>
          </div>

          <div class="grid gap-3 text-xs">
            <div>
              <div class="text-ink-400 uppercase tracking-wider font-bold mb-1">
                URL del webhook
              </div>
              <code
                class="block bg-cream-50 border border-cream-200 rounded px-3 py-2 break-all select-all"
                >{account.webhook_url}</code
              >
            </div>
            <div>
              <div class="text-ink-400 uppercase tracking-wider font-bold mb-1">
                Token de verificación
              </div>
              <code
                class="block bg-cream-50 border border-cream-200 rounded px-3 py-2 break-all select-all"
                >{account.verify_token ?? "—"}</code
              >
            </div>
          </div>

          <div class="grid md:grid-cols-2 gap-4">
            <FormField label="Token de acceso" for="at-{account.id}">
              <Input
                id="at-{account.id}"
                type="password"
                bind:value={accessTokens[account.id]}
                placeholder={account.has_access_token
                  ? "Configurado — escribe para reemplazarlo"
                  : "Sin configurar"}
              />
            </FormField>
            <FormField label="App secret de Meta" for="as-{account.id}">
              <Input
                id="as-{account.id}"
                type="password"
                bind:value={appSecrets[account.id]}
                placeholder={account.has_app_secret
                  ? "Configurado — escribe para reemplazarlo"
                  : "Sin configurar"}
              />
            </FormField>
          </div>
          {#if auth.isPlatformOperator}
            <FormField
              label="Token de verificación (reemplazar)"
              for="vt-{account.id}"
            >
              <Input
                id="vt-{account.id}"
                type="password"
                bind:value={verifyTokens[account.id]}
                placeholder="Dejar vacío para conservar el generado"
              />
            </FormField>
          {/if}
          <div class="flex justify-end">
            <Button
              size="sm"
              disabled={saving === account.id ||
                (!accessTokens[account.id] &&
                  !appSecrets[account.id] &&
                  !verifyTokens[account.id])}
              onclick={() => save(account)}
            >
              {saving === account.id ? "Guardando..." : "Guardar credenciales"}
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</SectionShell>
{/if}
