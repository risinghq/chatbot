<script lang="ts">
import { goto } from "$app/navigation";
import type { Product } from "@vendeya/types";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import {
  validateRequired,
  hasErrors,
  type ValidationErrors,
} from "#lib/utils/validation.js";
import Button from "#lib/components/ui/button.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();
let product: Product | null = $derived(data.product);

let formData = $state({
  name: "",
  category: "",
  brand: "",
  model: "",
  specs: "{}",
});

let errors = $state<ValidationErrors>({});
let isSaving = $state(false);

$effect(() => {
  if (product) {
    formData = {
      name: product.name,
      category: product.category,
      brand: product.brand || "",
      model: product.model || "",
      specs: product.specs_json || "{}",
    };
  } else {
    // defaults
  }
});

function validate(): boolean {
  const newErrors: ValidationErrors = {};

  const nameError = validateRequired(formData.name, "El nombre");
  if (nameError) newErrors.name = nameError;

  const categoryError = validateRequired(formData.category, "La categoría");
  if (categoryError) newErrors.category = categoryError;

  try {
    JSON.parse(formData.specs);
  } catch {
    newErrors.specs = "JSON inválido";
  }

  errors = newErrors;
  return !hasErrors(newErrors);
}

function goBack() {
  goto(`/dashboard/catalog`);
}

async function handleSave() {
  if (!validate()) {
    toast.error("Por favor corrige los errores en el formulario");
    return;
  }

  isSaving = true;
  try {
    const payload = {
      name: formData.name.trim(),
      category: formData.category.trim(),
      brand: formData.brand.trim() || null,
      model: formData.model.trim() || null,
      specs_json: formData.specs,
    };

    if (!product) {
      // Create
      await fetchApi("/api/catalog/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast.success("Producto base creado");
    } else {
      // Update
      await fetchApi(`/api/catalog/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast.success("Producto base actualizado");
    }

    goBack();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Error al guardar");
  } finally {
    isSaving = false;
  }
}
</script>

<PageTitle title={product ? "Editar producto base" : "Nuevo producto base"} />

<div class="mx-auto max-w-3xl px-4 py-6 md:px-8 md:py-8">
    <PageHeader
        title={product ? product.name : "Nuevo producto base"}
        subtitle="La plantilla que los paquetes del catálogo reutilizan."
    />

    <div class="rounded-md border border-border bg-surface">
        <div class="p-4">
            <FormField label="Nombre del producto base*" for="name" error={errors.name}>
                <Input id="name" bind:value={formData.name} placeholder="Ej. Cocina Mabe 4 Hornillas" />
            </FormField>

            <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                <FormField label="Categoría*" for="category" error={errors.category}>
                    <Input id="category" bind:value={formData.category} placeholder="Ej. Cocinas" />
                </FormField>

                <FormField label="Marca" for="brand">
                    <Input id="brand" bind:value={formData.brand} placeholder="Ej. Mabe" />
                </FormField>
            </div>

            <FormField label="Modelo" for="model">
                <Input id="model" bind:value={formData.model} placeholder="Ej. EMP-4020" />
            </FormField>

            <FormField label="Especificaciones (JSON)" for="specs" error={errors.specs}>
                <Textarea
                    id="specs"
                    bind:value={formData.specs}
                    placeholder='&#123;"color": "blanco", "quemadores": 4&#125;'
                    class="font-mono text-sm"
                />
                <p class="mt-1.5 text-sm text-fg-muted">Debe ser JSON válido.</p>
            </FormField>
        </div>

        <div class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
             <Button variant="secondary" onclick={goBack} disabled={isSaving}>Cancelar</Button>
             <Button onclick={handleSave} disabled={isSaving}>{isSaving ? "Guardando…" : "Guardar"}</Button>
        </div>
    </div>
</div>
