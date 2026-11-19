<script lang="ts">
import { onMount } from "svelte";
import { fetchApi } from "#lib/utils/api.js";

type SetupStatus = {
  openai_configured: boolean;
  whatsapp_configured: boolean;
  calidda_configured: boolean;
  has_members: boolean;
  complete: boolean;
};

let status = $state<SetupStatus | null>(null);
let loading = $state(true);

const steps = $derived(
  status
    ? [
        {
          done: status.openai_configured,
          label: "Clave de OpenAI del negocio",
          hint: "El bot la usa para entender mensajes.",
          href: "/dashboard/admin/settings",
        },
        {
          done: status.whatsapp_configured,
          label: "Número de WhatsApp conectado",
          hint: "Token de acceso y app secret de Meta, y la URL del webhook.",
          href: "/dashboard/admin/channels",
        },
        {
          done: status.calidda_configured,
          label: "Cuenta de Cálidda",
          hint: "Usuario y contraseña para verificar crédito.",
          href: "/dashboard/admin/settings",
        },
        {
          done: status.has_members,
          label: "Al menos un miembro del equipo",
          hint: "Quien atiende las conversaciones del negocio.",
          href: "/dashboard/admin/users",
        },
      ]
    : [],
);

async function load() {
  loading = true;
  try {
    status = await fetchApi<SetupStatus>("/api/admin/setup-status");
  } catch {
    status = null;
  } finally {
    loading = false;
  }
}

onMount(load);
</script>

{#if !loading && status && !status.complete}
  <div class="border-t border-ink-900/10 pt-6 mb-6">
    <p
      class="text-xs uppercase tracking-widest text-ink-400 mb-4 font-bold"
    >
      Configuración pendiente
    </p>
    <ul class="space-y-3">
      {#each steps as step}
        <li>
          <a href={step.href} class="flex items-start gap-2 group">
            <span
              class="mt-1 w-2 h-2 rounded-full shrink-0 {step.done
                ? 'bg-green-500'
                : 'bg-orange-400'}"
            ></span>
            <span>
              <span
                class="block text-sm text-ink-900 group-hover:underline {step.done
                  ? 'line-through text-ink-400'
                  : ''}"
              >
                {step.label}
              </span>
              {#if !step.done}
                <span class="block text-xs text-ink-400 mt-0.5">
                  {step.hint}
                </span>
              {/if}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  </div>
{/if}
