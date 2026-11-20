<script lang="ts">
import type { ProductImage } from "@vendeya/types";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";

/** Matches MAX_PRODUCT_IMAGES in the backend's catalog images domain. */
const MAX_IMAGES = 10;

type Props = {
  productId: string;
  images: ProductImage[];
  canEdit: boolean;
};

let { productId, images: initial, canEdit }: Props = $props();

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
          </div>
          {#if canEdit}
            <div class="flex justify-between gap-2 px-2 py-1.5 text-sm">
              {#if index > 0}
                <button
                  type="button"
                  class="text-fg-muted hover:text-fg"
                  disabled={busy}
                  onclick={() => makeCover(image)}
                >
                  Hacer portada
                </button>
              {:else}
                <span></span>
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
