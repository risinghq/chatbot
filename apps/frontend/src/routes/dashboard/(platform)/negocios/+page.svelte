<script lang="ts">
import { goto } from "$app/navigation";
import { auth } from "#lib/state/auth.svelte.js";
import { fetchApi, ApiError } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";

let newName = $state("");
let creating = $state(false);

async function createBusiness(e: Event) {
  e.preventDefault();
  creating = true;
  try {
    const tenant = await fetchApi<{ id: string; name: string }>(
      "/api/tenants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      },
    );
    toast.success(`Negocio ${tenant.name} creado`);
    // Its home holds the checklist that sets it up.
    await goto(`/dashboard/${tenant.id}`);
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Error al crear el negocio",
    );
    creating = false;
  }
}
</script>

<PageTitle title="Negocios" />

<Page>
	<PageHeader title="Negocios" subtitle="Crea negocios y entra a uno para configurarlo." />

	<div class="flex max-w-2xl flex-col gap-6">
		<SectionShell title="Negocios" description="Entra a un negocio para administrarlo.">
			{#if auth.tenants.length === 0}
				<EmptyState title="Sin negocios" description="Crea el primero con el formulario de abajo." />
			{:else}
				<ul class="divide-y divide-border-subtle">
					{#each auth.tenants as tenant (tenant.id)}
						<li>
							<a
								href="/dashboard/{tenant.id}"
								class="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-hover"
							>
								<span class="min-w-0 truncate text-base text-fg">{tenant.name}</span>
								{#if !tenant.ai_configured}
									<Badge variant="warning">Sin clave de OpenAI</Badge>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</SectionShell>

		<form onsubmit={createBusiness}>
			<SectionShell title="Crear negocio" description="Nace sin catálogo, números ni miembros. Entras a él al crearlo.">
				<div class="p-4">
					<FormField label="Nombre" for="business-name" class="mb-0!">
						<Input id="business-name" bind:value={newName} placeholder="Bodega Los Andes" />
					</FormField>
				</div>
				<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
					<Button type="submit" disabled={creating || !newName.trim()}>
						{creating ? "Creando…" : "Crear negocio"}
					</Button>
				</footer>
			</SectionShell>
		</form>
	</div>
</Page>
