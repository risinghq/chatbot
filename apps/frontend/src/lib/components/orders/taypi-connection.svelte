<script lang="ts">
import { invalidateAll } from "$app/navigation";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, apiFetch, fetchApi } from "#lib/utils/api.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";

export type TaypiStatus = {
  connected: boolean;
  environment: "sandbox" | "production" | null;
  webhook_url: string;
  domain: string;
};

let { status }: { status: TaypiStatus | null } = $props();

let form = $state({ public_key: "", secret_key: "", webhook_secret: "" });
let error = $state<string | undefined>();
let isSaving = $state(false);
let editing = $state(false);

const showForm = $derived(status !== null && (!status.connected || editing));

async function save(e: Event) {
  e.preventDefault();
  isSaving = true;
  error = undefined;
  try {
    const saved = await fetchApi<{
      business_name: string | null;
      webhook_matches: boolean | null;
    }>("/api/admin/taypi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    form = { public_key: "", secret_key: "", webhook_secret: "" };
    editing = false;
    await invalidateAll();
    toast.success(
      saved.business_name
        ? `TAYPI conectado: ${saved.business_name}`
        : "TAYPI conectado",
    );
    if (saved.webhook_matches === false) {
      toast.info(
        "Pega la URL del webhook en tu panel de TAYPI para confirmar pagos al instante",
      );
    }
  } catch (err) {
    error =
      err instanceof ApiError && err.status === 400
        ? err.message
        : "No se pudo conectar TAYPI";
  } finally {
    isSaving = false;
  }
}

async function disconnect() {
  if (
    !confirm(
      "¿Desconectar TAYPI? Los links de pago abiertos dejarán de funcionar.",
    )
  )
    return;
  isSaving = true;
  try {
    const response = await apiFetch("/api/admin/taypi", { method: "DELETE" });
    if (!response.ok) throw new Error(String(response.status));
    await invalidateAll();
    toast.success("TAYPI desconectado");
  } catch {
    toast.error("No se pudo desconectar TAYPI");
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
  title="Cobros con TAYPI"
  description="Envía a tus clientes un link para pagar con Yape, Plin o la app de su banco. El pago se confirma solo en el pedido."
>
  {#snippet action()}
    {#if status?.connected && !editing}
      <Button size="sm" variant="secondary" onclick={() => (editing = true)}>Cambiar claves</Button>
    {/if}
  {/snippet}

  <div class="space-y-4 px-4 py-3">
    {#if status === null}
      <p class="text-sm text-fg-muted">Solo un administrador conecta TAYPI.</p>
    {:else}
      {#if status.connected}
        <p class="flex items-center gap-2 text-base text-fg">
          Conectado
          <Badge>{status.environment === "sandbox" ? "Prueba" : "Producción"}</Badge>
        </p>
      {/if}

      <ol class="list-decimal space-y-2 pl-5 text-sm text-fg-muted">
        <li>
          En tu panel de TAYPI, en Integraciones, registra este dominio:
          <button type="button" class="font-mono text-fg underline underline-offset-2" onclick={() => copy(status.domain)}>{status.domain}</button>
        </li>
        <li>
          En Webhooks, pega esta URL:
          <button type="button" class="break-all font-mono text-fg underline underline-offset-2" onclick={() => copy(status.webhook_url)}>{status.webhook_url}</button>
        </li>
        <li>Copia aquí tu clave pública, tu clave secreta y el secreto del webhook.</li>
      </ol>

      {#if showForm}
        <form onsubmit={save} class="space-y-1">
          <FormField label="Clave pública" for="taypi-pk">
            <Input id="taypi-pk" bind:value={form.public_key} placeholder="taypi_pk_test_…" autocomplete="off" />
          </FormField>
          <FormField label="Clave secreta" for="taypi-sk">
            <Input id="taypi-sk" type="password" bind:value={form.secret_key} placeholder="taypi_sk_test_…" autocomplete="off" />
          </FormField>
          <FormField label="Secreto del webhook" for="taypi-wh">
            <Input id="taypi-wh" type="password" bind:value={form.webhook_secret} autocomplete="off" />
          </FormField>
          {#if error}
            <p role="alert" class="mb-2 rounded-sm bg-danger-soft px-3 py-2 text-sm text-danger-text">{error}</p>
          {/if}
          <div class="flex gap-2">
            <Button type="submit" disabled={isSaving}>{isSaving ? "Conectando…" : "Conectar TAYPI"}</Button>
            {#if editing}
              <Button variant="secondary" onclick={() => (editing = false)} disabled={isSaving}>Cancelar</Button>
            {/if}
          </div>
        </form>
      {:else}
        <Button variant="danger" size="sm" onclick={disconnect} disabled={isSaving}>Desconectar</Button>
      {/if}
    {/if}
  </div>
</SectionShell>
