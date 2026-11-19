<script lang="ts">
import { onMount } from "svelte";
import Icon from "#lib/components/ui/icon.svelte";
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

const doneCount = $derived(steps.filter((s) => s.done).length);

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
	<section class="rounded-md border border-border bg-surface">
		<header class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
			<h2 class="text-md text-fg">Configura el negocio</h2>
			<span class="text-sm text-fg-muted tabular-nums">{doneCount} de {steps.length}</span>
		</header>
		<ul class="divide-y divide-border-subtle">
			{#each steps as step (step.label)}
				<li>
					<a href={step.href} class="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
						<span
							class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full {step.done
								? 'bg-success text-on-solid'
								: 'border border-border-strong'}"
						>
							{#if step.done}<Icon name="check" class="size-3" />{/if}
						</span>
						<span class="min-w-0">
							<span class="block text-base {step.done ? 'text-fg-muted line-through' : 'text-fg'}">
								{step.label}
							</span>
							{#if !step.done}
								<span class="block text-sm text-fg-muted">{step.hint}</span>
							{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	</section>
{/if}
