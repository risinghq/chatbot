<script lang="ts">
import { onMount } from "svelte";
import { invalidateAll } from "$app/navigation";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, apiFetch, fetchApi } from "#lib/utils/api.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";

type ShopifyStatus = {
  connected: boolean;
  shop_domain: string | null;
  last_synced_at: number | null;
  webhook_url: string;
};

// Null while the status is loading or the caller may not read it: only an
// admin connects Shopify.
let status = $state<ShopifyStatus | null>(null);
const webhookUrl = $derived(status?.webhook_url ?? "");

async function load() {
  try {
    status = await fetchApi<ShopifyStatus>("/api/admin/shopify");
  } catch {
    status = null;
  }
}

onMount(load);

let form = $state({ shop_domain: "", access_token: "", webhook_secret: "" });
let error = $state<string | undefined>();
let isSaving = $state(false);
let isSyncing = $state(false);
let editing = $state(false);

const showForm = $derived(status !== null && (!status.connected || editing));

const lastSync = $derived(
  status?.last_synced_at
    ? new Date(status.last_synced_at).toLocaleString("es-PE", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null,
);

async function save(e: Event) {
  e.preventDefault();
  isSaving = true;
  error = undefined;
  try {
    await fetchApi("/api/admin/shopify", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    form = { shop_domain: "", access_token: "", webhook_secret: "" };
    editing = false;
    await invalidateAll();
    toast.success("Shopify conectado");
    await syncNow();
  } catch (err) {
    error =
      err instanceof ApiError && err.status === 400
        ? err.message
        : "No se pudo conectar Shopify";
  } finally {
    isSaving = false;
  }
}

async function syncNow() {
  isSyncing = true;
  try {
    const summary = await fetchApi<{
      products: number;
      created: number;
      updated: number;
      failed: number;
    }>("/api/admin/shopify/sync", { method: "POST" });
    await invalidateAll();
    if (summary.failed > 0) {
      toast.error(
        `${summary.failed} de ${summary.products} productos no se pudieron importar`,
      );
    } else {
      toast.success(
        `Catálogo sincronizado: ${summary.products} productos (${summary.created} nuevos)`,
      );
    }
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "No se pudo sincronizar",
    );
  } finally {
    isSyncing = false;
  }
}

async function disconnect() {
  if (
    !confirm(
      "¿Desconectar Shopify? Los productos importados quedan en el catálogo pero dejan de actualizarse.",
    )
  )
    return;
  isSaving = true;
  try {
    const response = await apiFetch("/api/admin/shopify", { method: "DELETE" });
    if (!response.ok) throw new Error(String(response.status));
    await invalidateAll();
    toast.success("Shopify desconectado");
  } catch {
    toast.error("No se pudo desconectar Shopify");
  } finally {
    isSaving = false;
  }
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  toast.success("Copiado");
}
</script>

<SectionShell
  title="Shopify"
  description="Trae los productos, precios, stock y fotos de tu tienda Shopify. Un pedido confirmado se crea también en Shopify."
>
  {#snippet action()}
    {#if status?.connected && !editing}
      <Button size="sm" variant="secondary" onclick={() => (editing = true)}>Cambiar claves</Button>
    {/if}
  {/snippet}

  <div class="space-y-4 px-4 py-3">
    {#if status === null}
      <p class="text-sm text-fg-muted">Solo un administrador conecta Shopify.</p>
    {:else}
      {#if status.connected}
        <p class="flex items-center gap-2 text-base text-fg">
          Conectado a {status.shop_domain}
          {#if lastSync}<Badge>Última sincronización: {lastSync}</Badge>{/if}
        </p>
      {/if}

      <ol class="list-decimal space-y-2 pl-5 text-sm text-fg-muted">
        <li>
          En Shopify, en Configuración › Apps › Desarrollar apps, crea una app
          con los permisos <span class="font-mono">read_products</span>,
          <span class="font-mono">read_inventory</span> y
          <span class="font-mono">write_orders</span>. Copia su token de Admin API.
        </li>
        <li>
          En Configuración › Notificaciones › Webhooks, crea un webhook para
          <span class="font-mono">products/update</span>,
          <span class="font-mono">products/delete</span> e
          <span class="font-mono">inventory_levels/update</span> con esta URL:
          <button type="button" class="break-all font-mono text-fg underline underline-offset-2" onclick={() => copy(webhookUrl)}>{webhookUrl}</button>
          y pega aquí el secreto que Shopify muestra en esa página.
        </li>
      </ol>

      {#if showForm}
        <form onsubmit={save} class="space-y-1">
          <FormField label="Dominio de la tienda" for="shopify-domain">
            <Input id="shopify-domain" bind:value={form.shop_domain} placeholder="mitienda.myshopify.com" autocomplete="off" />
          </FormField>
          <FormField label="Token de Admin API" for="shopify-token">
            <Input id="shopify-token" type="password" bind:value={form.access_token} placeholder="shpat_…" autocomplete="off" />
          </FormField>
          <FormField label="Secreto de los webhooks" for="shopify-secret">
            <Input id="shopify-secret" type="password" bind:value={form.webhook_secret} autocomplete="off" />
          </FormField>
          {#if error}
            <p role="alert" class="mb-2 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>
          {/if}
          <div class="flex gap-2">
            <Button type="submit" disabled={isSaving}>{isSaving ? "Conectando…" : "Conectar Shopify"}</Button>
            {#if editing}
              <Button variant="secondary" onclick={() => (editing = false)} disabled={isSaving}>Cancelar</Button>
            {/if}
          </div>
        </form>
      {:else}
        <div class="flex gap-2">
          <Button size="sm" variant="secondary" onclick={syncNow} disabled={isSyncing}>{isSyncing ? "Sincronizando…" : "Sincronizar ahora"}</Button>
          <Button variant="danger" size="sm" onclick={disconnect} disabled={isSaving}>Desconectar</Button>
        </div>
      {/if}
    {/if}
  </div>
</SectionShell>
