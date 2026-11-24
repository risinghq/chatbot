<script lang="ts">
import type { ProductImage, ProductVariant } from "@vendeya/types";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import { hasPart, sharedParts } from "#lib/catalog/variant-parts.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";

/** Matches MAX_PRODUCT_IMAGES in the backend's catalog images domain. */
const MAX_IMAGES = 10;

type Props = {
  productId: string;
  images: ProductImage[];
  /** The product's variants, which a photo can be tagged with. */
  variants: ProductVariant[];
  canEdit: boolean;
};

let { productId, images: initial, variants, canEdit }: Props = $props();

let saved = $state<ProductImage[] | null>(null);
let images = $derived(saved ?? initial);
let busy = $state(false);
let picker = $state<HTMLInputElement | null>(null);

function failure(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function upload(files: FileList | null) {
  if (!files || files.length === 0) return;
  const room = MAX_IMAGES - images.length;
  const chosen = Array.from(files).slice(0, room);
  if (chosen.length < files.length) {
    toast.error(`Un producto lleva hasta ${MAX_IMAGES} fotos`);
  }

  busy = true;
  let added = images;
  try {
    for (const file of chosen) {
      const body = new FormData();
      body.append("image", file);
      const image = await fetchApi<ProductImage>(
        `/api/catalog/products/${productId}/images`,
        { method: "POST", body },
      );
      added = [...added, image];
      saved = added;
    }
  } catch (error) {
    toast.error(failure(error, "No se pudo subir la foto"));
  } finally {
    busy = false;
    if (picker) picker.value = "";
  }
}

async function makeCover(image: ProductImage) {
  const ids = [
    image.id,
    ...images.filter((i) => i.id !== image.id).map((i) => i.id),
  ];
  busy = true;
  try {
    saved = await fetchApi<ProductImage[]>(
      `/api/catalog/products/${productId}/images/order`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      },
    );
  } catch (error) {
    toast.error(failure(error, "No se pudo cambiar la portada"));
  } finally {
    busy = false;
  }
}

let parts = $derived(sharedParts(variants.map((v) => v.name)));
let variantName = $derived(
  new Map(variants.map((v) => [v.id, v.name ?? v.sku])),
);

/** What the photo's badge says: the option it shows, a variant, or a count. */
function tagLabel(image: ProductImage): string | null {
  const ids = image.variant_ids;
  if (ids.length === 0) return null;
  if (ids.length === 1) return variantName.get(ids[0]!) ?? "1 variante";
  const part = parts.find((p) => {
    const group = variants.filter((v) => hasPart(v.name, p));
    return (
      group.length === ids.length && group.every((v) => ids.includes(v.id))
    );
  });
  return part ?? `${ids.length} variantes`;
}

let tagging = $state<ProductImage | null>(null);
let tagOpen = $state(false);
let chosen = $state<string[]>([]);

function openTags(image: ProductImage) {
  tagging = image;
  chosen = [...image.variant_ids];
  tagOpen = true;
}

function partState(part: string): "all" | "some" | "none" {
  const group = variants.filter((v) => hasPart(v.name, part));
  const picked = group.filter((v) => chosen.includes(v.id)).length;
  return picked === group.length ? "all" : picked > 0 ? "some" : "none";
}

function togglePart(part: string) {
  const group = variants.filter((v) => hasPart(v.name, part)).map((v) => v.id);
  chosen =
    partState(part) === "all"
      ? chosen.filter((id) => !group.includes(id))
      : [...new Set([...chosen, ...group])];
}

function toggleVariant(id: string, on: boolean) {
  chosen = on ? [...chosen, id] : chosen.filter((v) => v !== id);
}

async function saveTags() {
  if (!tagging) return;
  busy = true;
  try {
    const image = await fetchApi<ProductImage>(
      `/api/catalog/images/${tagging.id}/variants`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant_ids: chosen }),
      },
    );
    saved = images.map((i) => (i.id === image.id ? image : i));
    tagOpen = false;
  } catch (error) {
    toast.error(failure(error, "No se pudieron guardar las variantes"));
  } finally {
    busy = false;
  }
}

async function remove(image: ProductImage) {
  busy = true;
  try {
    await fetchApi(`/api/catalog/images/${image.id}`, { method: "DELETE" });
    saved = images.filter((i) => i.id !== image.id);
  } catch (error) {
    toast.error(failure(error, "No se pudo eliminar la foto"));
  } finally {
    busy = false;
  }
}
</script>

<SectionShell
  title="Fotos"
  description="La primera es la portada: es la que ve el cliente en la lista y en WhatsApp."
>
  {#snippet action()}
    {#if canEdit}
      <input
        bind:this={picker}
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        onchange={(event) => upload(event.currentTarget.files)}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || images.length >= MAX_IMAGES}
        onclick={() => picker?.click()}
      >
        {busy ? "Subiendo…" : "Subir fotos"}
      </Button>
    {/if}
  {/snippet}

  {#if images.length > 0}
    <ul class="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 md:grid-cols-4">
      {#each images as image, index (image.id)}
        <li class="group overflow-hidden rounded-md border border-border-subtle">
          <div class="relative aspect-square bg-sunken">
            <img src={image.url} alt="" class="size-full object-cover" loading="lazy" />
            {#if index === 0}
              <Badge class="absolute top-2 left-2">Portada</Badge>
            {/if}
            {#if tagLabel(image)}
              <Badge variant="info" class="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate">
                {tagLabel(image)}
              </Badge>
            {/if}
          </div>
          {#if canEdit}
            <div class="flex flex-wrap justify-between gap-x-2 px-2 py-1.5 text-sm">
              {#if index > 0}
                <button
                  type="button"
                  class="text-fg-muted hover:text-fg"
                  disabled={busy}
                  onclick={() => makeCover(image)}
                >
                  Hacer portada
                </button>
              {/if}
              {#if variants.length > 1}
                <button
                  type="button"
                  class="text-fg-muted hover:text-fg"
                  disabled={busy}
                  onclick={() => openTags(image)}
                >
                  Variantes
                </button>
              {/if}
              <button
                type="button"
                class="text-fg-muted hover:text-danger-text"
                disabled={busy}
                onclick={() => remove(image)}
              >
                Eliminar
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="px-4 py-3 text-sm text-fg-muted">
      Sin fotos. Sube hasta {MAX_IMAGES}; se ajustan a 1024 px.
    </p>
  {/if}
</SectionShell>

<Modal
  bind:open={tagOpen}
  title="¿Qué variantes muestra esta foto?"
  subtitle="El asistente la envía cuando el cliente pregunta por esas variantes. Sin ninguna marcada, la foto es del producto entero y va con todas."
  onClose={() => (tagOpen = false)}
>
  {#if parts.length > 0}
    <div class="flex flex-wrap gap-1.5">
      {#each parts as part (part)}
        {@const state = partState(part)}
        <button
          type="button"
          class="rounded-full border px-2.5 py-0.5 text-sm {state === 'all'
            ? 'border-border-strong bg-sunken text-fg'
            : 'border-border text-fg-muted hover:text-fg'}"
          aria-pressed={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
          onclick={() => togglePart(part)}
        >
          {part}
        </button>
      {/each}
    </div>
  {/if}
  <ul class="flex max-h-64 flex-col gap-1 overflow-y-auto">
    {#each variants as variant (variant.id)}
      <li>
        <label class="flex items-center gap-2 text-base text-fg">
          <input
            type="checkbox"
            checked={chosen.includes(variant.id)}
            onchange={(event) => toggleVariant(variant.id, event.currentTarget.checked)}
          />
          {variant.name ?? variant.sku}
        </label>
      </li>
    {/each}
  </ul>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (tagOpen = false)} disabled={busy}>Cancelar</Button>
    <Button onclick={saveTags} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</Button>
  {/snippet}
</Modal>
