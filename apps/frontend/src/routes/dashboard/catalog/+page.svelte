<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import type { Product } from "@vendeya/types";
import { auth } from "#lib/state/auth.svelte.js";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Button from "#lib/components/ui/button.svelte";
import InventoryGrid from "#lib/components/catalog/inventory-grid.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

function handleProductClick(product: Product) {
  goto(`/dashboard/catalog/inventory/${product.id}`);
}

onMount(() => {
  if (!data.user) {
    window.location.href = "/login";
  }
});
</script>

<PageTitle title="Catálogo" />

<Page>
  <PageHeader title="Catálogo">
    {#snippet actions()}
      {#if auth.canEditCatalog}
        <Button size="sm" href="/dashboard/catalog/inventory/new">Nuevo producto</Button>
      {/if}
    {/snippet}
  </PageHeader>

  <InventoryGrid products={data.products} onProductClick={handleProductClick} />
</Page>
