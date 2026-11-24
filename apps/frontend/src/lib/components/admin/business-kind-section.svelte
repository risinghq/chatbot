<script lang="ts">
import { BUSINESS_KINDS, isBusinessKind } from "@vendeya/types";
import { BUSINESS_KIND_PROFILES } from "#lib/catalog/business-kinds.js";
import FormField from "#lib/components/ui/form-field.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import Select from "#lib/components/ui/select.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";

const items = BUSINESS_KINDS.map((kind) => ({
  value: kind,
  label: BUSINESS_KIND_PROFILES[kind].label,
}));

let saving = $state(false);

// One choice, so it saves when picked rather than waiting for the page's bar.
async function change(e: Event & { currentTarget: HTMLSelectElement }) {
  const kind = e.currentTarget.value;
  if (!isBusinessKind(kind)) return;
  saving = true;
  try {
    await fetchApi("/api/admin/business", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_kind: kind }),
    });
    await auth.loadTenants();
    toast.success("Tipo de negocio actualizado");
  } catch {
    toast.error("No se pudo cambiar el tipo de negocio");
  } finally {
    saving = false;
  }
}
</script>

<SectionShell
  title="Tu negocio"
  description="Lo que vendes. El catálogo sugiere las opciones de cada producto según esto: tallas y colores para ropa, presentaciones para comida."
>
  <div class="p-4">
    <FormField label="¿Qué vendes?" for="business-kind" class="mb-0!">
      <Select
        id="business-kind"
        value={auth.openTenant?.business_kind ?? undefined}
        placeholder="Sin elegir"
        disabled={saving}
        {items}
        onchange={change}
      />
    </FormField>
  </div>
</SectionShell>
