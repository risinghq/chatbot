<script lang="ts">
import { businessPath } from "#lib/state/business.svelte.js";
import { goto } from "$app/navigation";
import type { Product, ProductStatus } from "@vendeya/types";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import {
  validateRequired,
  hasErrors,
  type ValidationErrors,
} from "#lib/utils/validation.js";
import Button from "#lib/components/ui/button.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import ProductImages from "#lib/components/catalog/product-images.svelte";
import VariantList from "#lib/components/catalog/variant-list.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();
let product: Product | null = $derived(data.product);
let canEdit = $derived(auth.canEditCatalog);

const STATUS_ITEMS: { value: ProductStatus; label: string }[] = [
  { value: "active", label: "Activo: el asistente lo ofrece" },
  { value: "draft", label: "Borrador: todavía no se ofrece" },
  { value: "archived", label: "Archivado: ya no se vende" },
];

let formData = $state({
  name: "",
  description: "",
  category: "",
  brand: "",
  model: "",
  status: "active" as ProductStatus,
});

let errors = $state<ValidationErrors>({});
let isSaving = $state(false);

$effect(() => {
  if (product) {
    formData = {
      name: product.name,
      description: product.description ?? "",
      category: product.category,
      brand: product.brand || "",
      model: product.model || "",
      status: product.status,
    };
  }
});

function validate(): boolean {
  const newErrors: ValidationErrors = {};

  const nameError = validateRequired(formData.name, "El nombre");
  if (nameError) newErrors.name = nameError;

  const categoryError = validateRequired(formData.category, "La categoría");
  if (categoryError) newErrors.category = categoryError;

  errors = newErrors;
  return !hasErrors(newErrors);
}

function goBack() {
  goto(`${businessPath()}/catalog`);
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
      description: formData.description.trim() || null,
      category: formData.category.trim(),
      brand: formData.brand.trim() || null,
      model: formData.model.trim() || null,
      status: formData.status,
    };

    if (!product) {
      const created = await fetchApi<Product>("/api/catalog/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast.success("Producto creado. Agrega sus variantes.");
      // The new product's page is where its variants are added.
      await goto(`${businessPath()}/catalog/inventory/${created.id}`, {
        replaceState: true,
      });
    } else {
      await fetchApi(`/api/catalog/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast.success("Producto actualizado");
      goBack();
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Error al guardar");
  } finally {
    isSaving = false;
  }
}
</script>

<PageTitle title={product ? product.name : "Nuevo producto"} />

<Page width="narrow">
    <PageHeader
        title={product ? product.name : "Nuevo producto"}
        subtitle={product
            ? "Lo que el asistente sabe de este producto, y sus variantes."
            : "Primero los datos del producto; después agregas sus variantes."}
    />

    <div class="flex flex-col gap-6">
        <div class="rounded-md border border-border bg-surface">
            <fieldset class="p-4" disabled={!canEdit}>
                <FormField label="Nombre*" for="name" error={errors.name}>
                    <Input id="name" bind:value={formData.name} placeholder="Ej. Polo básico de algodón" />
                </FormField>

                <FormField label="Descripción" for="description">
                    <Textarea
                        id="description"
                        bind:value={formData.description}
                        placeholder="Lo que el asistente cuenta al cliente: material, uso, garantía."
                    />
                </FormField>

                <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                    <FormField label="Categoría*" for="category" error={errors.category}>
                        <Input id="category" bind:value={formData.category} placeholder="Ej. Ropa" />
                    </FormField>

                    <FormField label="Estado" for="status">
                        <Select id="status" bind:value={formData.status} items={STATUS_ITEMS} />
                    </FormField>

                    <FormField label="Marca" for="brand">
                        <Input id="brand" bind:value={formData.brand} />
                    </FormField>

                    <FormField label="Modelo" for="model">
                        <Input id="model" bind:value={formData.model} />
                    </FormField>
                </div>
            </fieldset>

            {#if canEdit}
                <div class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
                    <Button variant="secondary" onclick={goBack} disabled={isSaving}>Cancelar</Button>
                    <Button onclick={handleSave} disabled={isSaving}>
                        {isSaving ? "Guardando…" : product ? "Guardar" : "Crear producto"}
                    </Button>
                </div>
            {/if}
        </div>

        {#if product}
            {#key product.id}
                <ProductImages productId={product.id} images={data.images} {canEdit} />
                <VariantList productId={product.id} variants={data.variants} stock={data.stock} {canEdit} />
            {/key}
        {/if}
    </div>
</Page>
