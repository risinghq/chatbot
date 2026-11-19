<script lang="ts">
import { onMount } from "svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { fetchApi, ApiError } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import SetupChecklist from "#lib/components/shared/setup-checklist.svelte";
import { MIN_PASSWORD_LENGTH } from "@vendeya/types";

type Member = {
  id: string;
  username: string;
  name: string;
  role: string;
  is_active: number;
};

let newName = $state("");
let newSlug = $state("");
let creating = $state(false);

let members = $state<Member[]>([]);
let membersLoading = $state(false);
let memberMode = $state<"new" | "existing">("new");
let memberUsername = $state("");
let memberFullName = $state("");
let memberPassword = $state("");
let memberRole = $state("admin");
let addingMember = $state(false);

const roleLabels: Record<string, string> = {
  admin: "Administrador",
  developer: "Desarrollador",
  supervisor: "Supervisor",
  sales_agent: "Agente de ventas",
};

// The slug is a lookup key in the URL and the CLI, so the form derives a safe
// one from the name and lets the operator adjust it.
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

let slugTouched = $state(false);
$effect(() => {
  if (!slugTouched) newSlug = slugify(newName);
});

async function createBusiness(e: Event) {
  e.preventDefault();
  creating = true;
  try {
    const tenant = await fetchApi<{ id: string; name: string }>(
      "/api/tenants",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: newSlug, name: newName }),
      },
    );
    toast.success(`Negocio ${tenant.name} creado`);
    // Enter it so the checklist and the member form act on the new business.
    await auth.selectTenant(tenant.id);
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Error al crear el negocio",
    );
    creating = false;
  }
}

async function loadMembers() {
  if (!auth.activeTenantId) {
    members = [];
    return;
  }
  membersLoading = true;
  try {
    const res = await fetchApi<{ users: Member[] }>("/api/admin/users");
    members = res.users;
  } catch {
    members = [];
  } finally {
    membersLoading = false;
  }
}

async function addMember(e: Event) {
  e.preventDefault();
  const tenantId = auth.activeTenantId;
  if (!tenantId) return;
  addingMember = true;
  try {
    if (memberMode === "existing") {
      await fetchApi(`/api/tenants/${tenantId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: memberUsername,
          role: memberRole,
        }),
      });
    } else {
      await fetchApi("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: memberUsername,
          name: memberFullName,
          password: memberPassword,
          role: memberRole,
        }),
      });
    }
    toast.success("Miembro agregado");
    memberUsername = "";
    memberFullName = "";
    memberPassword = "";
    memberRole = "admin";
    await loadMembers();
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Error al agregar el miembro",
    );
  } finally {
    addingMember = false;
  }
}

onMount(() => {
  loadMembers();
});
</script>

<PageTitle title="Negocios" />

<div class="max-w-7xl mx-auto p-8 md:p-12 min-h-screen">
  <PageHeader
    title="Negocios"
    subtitle="Alta y administración de los negocios de la plataforma"
  />

  <div class="grid gap-6 lg:grid-cols-2">
    <div class="space-y-6">
      <SectionShell
        title="Crear negocio"
        description="Un negocio nuevo nace sin catálogo, números ni miembros."
      >
        <form class="p-6 space-y-4" onsubmit={createBusiness}>
          <FormField label="Nombre" for="business-name">
            <Input
              id="business-name"
              bind:value={newName}
              placeholder="Ej. Bodega Los Andes"
            />
          </FormField>
          <FormField label="Slug" for="business-slug">
            <Input
              id="business-slug"
              bind:value={newSlug}
              placeholder="bodega-los-andes"
              oninput={() => (slugTouched = true)}
            />
            <p class="text-xs text-ink-500 mt-1">
              Minúsculas, números y guiones. Identifica al negocio y no se puede
              cambiar.
            </p>
          </FormField>
          <div class="flex justify-end">
            <Button type="submit" disabled={creating || !newName || !newSlug}>
              {creating ? "Creando..." : "Crear negocio"}
            </Button>
          </div>
        </form>
      </SectionShell>

      <SectionShell
        title="Negocios"
        description="Entra a un negocio para administrarlo."
      >
        {#if auth.tenants.length === 0}
          <div class="p-8 text-sm text-ink-500">
            Todavía no hay negocios. Crea el primero con el formulario de
            arriba.
          </div>
        {:else}
          <div class="divide-y divide-ink-100/50">
            {#each auth.tenants as tenant (tenant.id)}
              <div class="p-6 flex items-center justify-between gap-4">
                <div>
                  <div class="font-medium text-sm text-ink-900">
                    {tenant.name}
                  </div>
                  <div class="text-xs text-ink-500 font-mono mt-0.5">
                    {tenant.slug}
                  </div>
                </div>
                {#if auth.activeTenantId === tenant.id}
                  <span
                    class="text-xs font-bold uppercase tracking-wider text-green-700"
                  >
                    Activo
                  </span>
                {:else}
                  <Button
                    size="sm"
                    variant="outline"
                    onclick={() => auth.selectTenant(tenant.id)}
                  >
                    Entrar
                  </Button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </SectionShell>
    </div>

    <div class="space-y-6">
      {#if auth.activeTenantId}
        <SectionShell
          title="Configuración del negocio activo"
          description="Lo que falta antes de que el negocio pueda vender."
        >
          <div class="p-6">
            <SetupChecklist />
          </div>
        </SectionShell>

        <SectionShell
          title="Miembros del negocio activo"
          description="Quién puede entrar al panel de este negocio."
        >
          {#if membersLoading}
            <div class="p-8 space-y-4 animate-pulse">
              <div class="h-10 bg-cream-50 rounded w-full"></div>
            </div>
          {:else}
            <div class="divide-y divide-ink-100/50">
              {#each members as member (member.id)}
                <div class="px-6 py-3 flex items-center justify-between">
                  <div>
                    <div class="font-medium text-sm text-ink-900">
                      {member.name}
                    </div>
                    <div class="text-xs text-ink-500 font-mono">
                      @{member.username}
                    </div>
                  </div>
                  <span class="text-xs text-ink-500">
                    {roleLabels[member.role] ?? member.role}
                  </span>
                </div>
              {:else}
                <div class="p-6 text-sm text-ink-500">
                  Este negocio no tiene miembros todavía.
                </div>
              {/each}
            </div>
          {/if}

          <form
            class="p-6 border-t border-ink-100/50 space-y-4"
            onsubmit={addMember}
          >
            <div class="flex gap-6 text-sm">
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="member-mode"
                  value="new"
                  bind:group={memberMode}
                  class="h-4 w-4 border-ink-300 text-ink-900 focus:ring-ink-900"
                />
                Usuario nuevo
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="member-mode"
                  value="existing"
                  bind:group={memberMode}
                  class="h-4 w-4 border-ink-300 text-ink-900 focus:ring-ink-900"
                />
                Usuario existente
              </label>
            </div>

            <FormField label="Usuario" for="member-username">
              <Input
                id="member-username"
                bind:value={memberUsername}
              />
            </FormField>
            {#if memberMode === "new"}
              <FormField label="Nombre" for="member-name">
                <Input
                  id="member-name"
                  bind:value={memberFullName}
                />
              </FormField>
              <FormField label="Contraseña" for="member-password">
                <Input
                  id="member-password"
                  type="password"
                  bind:value={memberPassword}
                />
                <p class="text-xs text-ink-500 mt-1">
                  Mínimo {MIN_PASSWORD_LENGTH} caracteres.
                </p>
              </FormField>
            {/if}
            <FormField label="Rol" for="member-role">
              <select
                id="member-role"
                bind:value={memberRole}
                class="w-full border border-ink-200 bg-white px-3 py-2 text-sm rounded focus:ring-ink-900 focus:border-ink-900"
              >
                {#each Object.entries(roleLabels) as [value, label]}
                  <option {value}>{label}</option>
                {/each}
              </select>
            </FormField>
            <div class="flex justify-end">
              <Button
                type="submit"
                disabled={addingMember ||
                  !memberUsername ||
                  (memberMode === "new" &&
                    (!memberFullName || !memberPassword))}
              >
                {addingMember ? "Agregando..." : "Agregar miembro"}
              </Button>
            </div>
          </form>
        </SectionShell>
      {:else}
        <SectionShell
          title="Configuración"
          description="Entra a un negocio para ver su configuración pendiente y sus miembros."
        >
          <div class="p-6 text-sm text-ink-500">
            Ningún negocio está activo. Usa Entrar en la lista de la izquierda.
          </div>
        </SectionShell>
      {/if}
    </div>
  </div>
</div>
