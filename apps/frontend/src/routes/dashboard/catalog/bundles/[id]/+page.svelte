<script lang="ts">
import { goto } from "$app/navigation";
import type { Bundle, SnapshotProduct, Product } from "@vendeya/types";
import Button from "#lib/components/ui/button.svelte";
import ImageUploadSimple from "#lib/components/catalog/image-upload-simple.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Icon from "#lib/components/ui/icon.svelte";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi, createFormData } from "#lib/utils/api.js";
import {
  validateRequired,
  validatePositiveNumber,
  validateImage,
  hasErrors,
  type ValidationErrors,
} from "#lib/utils/validation.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let baseProducts = $derived(data.baseProducts);
let bundle: Bundle | null = $derived(data.bundle);
let periodId = $derived(data.periodId);
let segment = $derived(data.segment);

let formData = $state({
  name: "",
  price: "",
  primaryCategory: "",
});

let items = $state<string[]>([]); // Array of product IDs
let installments = $state<Record<string, string>>({
  3: "",
  6: "",
  9: "",
  12: "",
  18: "",
});

let image = $state<File | null>(null);
let errors = $state<ValidationErrors>({});
let isSaving = $state(false);

const MONTH_OPTIONS = ["3", "6", "9", "12", "18"];

let productOptions = $derived(
  baseProducts.map((p: Product) => ({ value: p.id, label: p.name })),
);

$effect(() => {
  if (bundle) {
    formData = {
      name: bundle.name,
      price: String(bundle.price),
      primaryCategory: bundle.primary_category,
    };
    try {
      const comp = JSON.parse(bundle.composition_json);
      if (comp.fixed) {
        items = comp.fixed.map((p: SnapshotProduct) => p.id);
      }
      const sched = JSON.parse(bundle.installments_json);
      const newInst: Record<string, string> = {
        3: "",
        6: "",
        9: "",
        12: "",
        18: "",
      };
      if (Array.isArray(sched)) {
        sched.forEach((s: any) => {
          if (MONTH_OPTIONS.includes(String(s.months))) {
            newInst[String(s.months)] = String(s.monthlyAmount);
          }
        });
      }
      installments = newInst;
    } catch {
      items = [];
    }
  } else if (items.length === 0) {
    // Initialize with one empty item slot if new
    items = [""];
  }
});

function addItem() {
  items = [...items, ""];
}

function updateItem(index: number, productId: string) {
  const newItems = [...items];
  newItems[index] = productId;
  items = newItems;
}

function removeItem(index: number) {
  const newItems = [...items];
  newItems.splice(index, 1);
  items = newItems;
}

function validate(): boolean {
  const newErrors: ValidationErrors = {};

  const nameError = validateRequired(formData.name, "El nombre");
  if (nameError) newErrors.name = nameError;

  const priceError = validatePositiveNumber(formData.price, "El precio");
  if (priceError) newErrors.price = priceError;

  const catError = validateRequired(formData.primaryCategory, "La categoría");
  if (catError) newErrors.primaryCategory = catError;

  if (items.filter((id) => !!id).length === 0) {
    newErrors.items = "Agrega al menos un producto";
  }

  if (!bundle) {
    const imageError = validateImage(image, true);
    if (imageError) newErrors.image = imageError;
  }

  errors = newErrors;
  return !hasErrors(newErrors);
}

function goBack() {
  // Preserve period selection
  const query = periodId ? `?period=${periodId}` : "";
  // After redirect, would be nice to activate the relevant tab via URL param
  // The +page.svelte defaults to inventory or keeps state if persistent.
  // We should probably add tab param support to catalog/+page.svelte later.
  goto(`/dashboard/catalog${query}`);
}

async function handleSave() {
  if (!periodId && !bundle) {
    toast.error("No se ha seleccionado un período");
    return;
  }

  if (!validate()) return;

  isSaving = true;
  try {
    const selectedProducts = items.flatMap((id) => {
      if (!id) return [];

      const product = baseProducts.find((p: Product) => p.id === id);
      return product ? [product] : [];
    });

    const composition = {
      fixed: selectedProducts.map((p) => ({
        id: p.id,
        name: p.name,
        specs: JSON.parse(p.specs_json || "{}"),
      })),
      choices: [],
    };

    const schedule = MONTH_OPTIONS.filter(
      (m) => installments[m] && parseFloat(installments[m]) > 0,
    ).map((m) => {
      const amount = installments[m] || "0";
      return {
        months: parseInt(m, 10),
        monthlyAmount: parseFloat(amount),
        totalAmount: parseFloat(amount) * parseInt(m, 10),
      };
    });

    const payloadRaw = {
      period_id: periodId,
      name: formData.name,
      price: formData.price,
      primary_category: formData.primaryCategory,
      categories_json: "[]",
      composition_json: JSON.stringify(composition),
      installments_json: JSON.stringify(schedule),
    };

    // Create Mode
    if (!bundle) {
      const payload = createFormData({
        ...payloadRaw,
        segment,
        image,
      });
      await fetchApi("/api/catalog/bundles", {
        method: "POST",
        body: payload,
      });
      toast.success("Paquete creado con éxito");
    }
    // Edit Mode
    else {
      await fetchApi(`/api/catalog/bundles/${bundle.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          price: parseFloat(formData.price),
          primary_category: formData.primaryCategory,
          composition_json: JSON.stringify(composition),
          installments_json: JSON.stringify(schedule),
        }),
      });
      if (image) {
        const imgForm = createFormData({ image });
        await fetchApi(`/api/catalog/bundles/${bundle.id}/image`, {
          method: "POST",
          body: imgForm,
        });
      }
      toast.success("Paquete actualizado");
    }

    goBack();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Error al guardar");
  } finally {
    isSaving = false;
  }
}
</script>

<PageTitle title={bundle ? "Editar bundle" : "Nuevo bundle"} />

<Page width="narrow">
    <PageHeader
        title={segment === "fnb"
            ? bundle ? "Editar oferta FNB" : "Nueva oferta FNB"
            : bundle ? "Editar paquete" : "Nuevo paquete"}
        subtitle="Composición, precio y cuotas."
    />

    <div class="divide-y divide-border-subtle rounded-md border border-border bg-surface">
        <div class="grid grid-cols-1 gap-x-6 p-4 md:grid-cols-3">
            <div class="md:col-span-1">
                <ImageUploadSimple
                    hasExistingImage={!!bundle}
                    bind:image
                    error={errors.image}
                    onImageChange={(f) => (image = f)}
                />
            </div>

            <div class="md:col-span-2">
                <FormField
                    label="Nombre comercial*"
                    for="name"
                    error={errors.name}
                >
                    <Input
                        id="name"
                        bind:value={formData.name}
                        placeholder="Ej. Combo Cocina + Licuadora"
                    />
                </FormField>

                <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                    <FormField
                        label="Precio al contado (S/)*"
                        for="price"
                        error={errors.price}
                    >
                        <Input
                            type="number"
                            id="price"
                            bind:value={formData.price}
                        />
                    </FormField>

                    <FormField
                        label="Categoría principal*"
                        for="category"
                        error={errors.primaryCategory}
                    >
                        <Input
                            id="category"
                            bind:value={formData.primaryCategory}
                            placeholder="Ej. Cocinas"
                        />
                    </FormField>
                </div>
            </div>
        </div>

        <section class="p-4">
            <h2 class="text-md font-medium text-fg">Composición</h2>
            <p class="mt-1 mb-3 text-base text-fg-muted">
                Los productos base que incluye el paquete.
            </p>

            {#if errors.items}
                <p role="alert" class="mb-2 text-sm text-danger-text">{errors.items}</p>
            {/if}

            <div class="flex flex-col gap-2">
                {#each items as itemId, i}
                    <div class="flex items-center gap-2">
                        <span class="w-6 text-right text-sm text-fg-muted tabular-nums">{i + 1}.</span>
                        <div class="flex-1">
                            <Select
                                value={itemId}
                                items={productOptions}
                                placeholder="Seleccionar producto..."
                                onchange={(e) =>
                                    updateItem(
                                        i,
                                        (e.currentTarget as any).value,
                                    )}
                            />
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            onclick={() => removeItem(i)}
                            aria-label="Quitar producto {i + 1}"
                            class="text-fg-muted hover:text-danger-text"
                        >
                            <Icon name="close" />
                        </Button>
                    </div>
                {/each}
                <div class="pl-8">
                    <Button variant="secondary" size="sm" onclick={addItem}>Agregar producto</Button>
                </div>
            </div>
        </section>

        <section class="p-4">
            <h2 class="text-md font-medium text-fg">Cuotas mensuales</h2>
            <p class="mt-1 mb-3 text-base text-fg-muted">
                La cuota de cada plazo. Deja vacío el plazo que no se ofrece.
            </p>
            <div class="grid grid-cols-2 gap-x-3 md:grid-cols-5">
                {#each MONTH_OPTIONS as months}
                    <FormField label={`${months} meses`}>
                        <Input
                            type="number"
                            bind:value={installments[months]}
                            placeholder="S/"
                            class="text-right"
                        />
                    </FormField>
                {/each}
            </div>
        </section>

        <div class="flex justify-end gap-2 px-4 py-3">
            <Button variant="secondary" onclick={goBack} disabled={isSaving}>Cancelar</Button>
            <Button onclick={handleSave} disabled={isSaving}>{isSaving ? "Guardando…" : "Guardar"}</Button>
        </div>
    </div>
</Page>
