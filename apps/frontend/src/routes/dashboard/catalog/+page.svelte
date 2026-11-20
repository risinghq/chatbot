<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import type {
  Product,
  Bundle,
  CatalogPeriod,
  StockStatus,
} from "@vendeya/types";
import { auth } from "#lib/state/auth.svelte.js";
import { fetchApi } from "#lib/utils/api.js";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Banner from "#lib/components/ui/banner.svelte";
import Button from "#lib/components/ui/button.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import InventoryGrid from "#lib/components/catalog/inventory-grid.svelte";
import BundleGrid from "#lib/components/catalog/bundle-grid.svelte";
import PeriodSelector from "#lib/components/catalog/period-selector.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Tabs from "#lib/components/ui/tabs.svelte";
import TabsList from "#lib/components/ui/tabs-list.svelte";
import TabsTrigger from "#lib/components/ui/tabs-trigger.svelte";
import TabsContent from "#lib/components/ui/tabs-content.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

let activeTab = $state("inventory");

let localBaseProducts = $state<Product[]>([]);
let localBundles = $state<Bundle[]>([]);
let localFnbBundles = $state<Bundle[]>([]);
let localPeriods = $state<CatalogPeriod[]>([]);
let selectedPeriod = $state<CatalogPeriod | null>(null);

let baseProducts = $derived(
  localBaseProducts.length > 0 ? localBaseProducts : data.baseProducts,
);
let bundles = $derived(localBundles.length > 0 ? localBundles : data.bundles);
let fnbBundles = $derived(
  localFnbBundles.length > 0 ? localFnbBundles : data.fnbOfferings,
);
let periods = $derived(localPeriods.length > 0 ? localPeriods : data.periods);
let currentPeriod = $derived(selectedPeriod || data.activePeriod);

let offersTab = $derived(activeTab !== "inventory");

let canEdit = $derived(
  auth.canEditCatalog && currentPeriod?.status === "draft",
);

async function loadData(periodId?: string) {
  try {
    const pid = periodId || currentPeriod?.id;

    // Parallel fetch
    const [pRes, bRes, fRes] = await Promise.all([
      fetchApi<Product[]>("/api/catalog/products"),
      pid
        ? fetchApi<Bundle[]>(
            `/api/catalog/bundles?period_id=${pid}&segment=gaso`,
          )
        : Promise.resolve([]),
      pid
        ? fetchApi<Bundle[]>(
            `/api/catalog/bundles?period_id=${pid}&segment=fnb`,
          )
        : Promise.resolve([]),
    ]);

    localBaseProducts = pRes;
    localBundles = bRes;
    localFnbBundles = fRes;
  } catch (error) {
    console.error("Failed to load catalog data:", error);
  }
}

function handlePeriodChange(period: CatalogPeriod) {
  selectedPeriod = period;
  goto(`?period=${period.id}`, { replaceState: true });
  loadData(period.id);
}

function handleProductClick(product: Product) {
  if (auth.isAdmin) {
    goto(`/dashboard/catalog/inventory/${product.id}`);
  }
}

function handleBundleClick(bundle: Bundle) {
  if (canEdit) {
    const pParam = currentPeriod ? `?period=${currentPeriod.id}` : "";
    goto(`/dashboard/catalog/bundles/${bundle.id}${pParam}`);
  }
}

function handleFnbBundleClick(bundle: Bundle) {
  if (canEdit) {
    const pParam = currentPeriod ? `?period=${currentPeriod.id}` : "";
    // Use unified bundle editor for both GASO and FnB
    goto(`/dashboard/catalog/bundles/${bundle.id}${pParam}`);
  }
}

function handleStockUpdate(id: string, newStatus: StockStatus) {
  if (activeTab === "inventory") {
    // no-op
  } else if (activeTab === "gaso") {
    const item = bundles.find((b: Bundle) => b.id === id);
    if (item) item.stock_status = newStatus;
  } else if (activeTab === "fnb") {
    const item = fnbBundles.find((b: Bundle) => b.id === id);
    if (item) item.stock_status = newStatus;
  }
}

function openCreatePage() {
  const pParam = currentPeriod ? `?period=${currentPeriod.id}` : "";
  if (activeTab === "inventory") {
    goto(`/dashboard/catalog/inventory/new`);
  } else if (activeTab === "gaso") {
    goto(`/dashboard/catalog/bundles/new${pParam}&segment=gaso`);
  } else if (activeTab === "fnb") {
    goto(`/dashboard/catalog/bundles/new${pParam}&segment=fnb`);
  }
}

onMount(() => {
  if (!data.user) {
    window.location.href = "/login";
  }
});
</script>

<PageTitle title="Catálogo" />

{#snippet noPeriod()}
  <EmptyState
    title="Todavía no hay períodos"
    description="Las ofertas viven en un período mensual. El asistente cotiza las del período activo."
  >
    {#snippet action()}
      {#if auth.isAdmin}
        <Button href="/dashboard/admin/periods">Crear período</Button>
      {/if}
    {/snippet}
  </EmptyState>
{/snippet}

<Page>
  <PageHeader
    title="Catálogo"
    subtitle={offersTab && currentPeriod
      ? `Período: ${currentPeriod.name}`
      : undefined}
  >
    {#snippet actions()}
      <!-- Periods hold offers only; base products have none. -->
      {#if offersTab && periods.length > 0}
        <PeriodSelector
          {periods}
          selected={currentPeriod}
          onSelect={handlePeriodChange}
        />
        {#if auth.isAdmin}
          <Button variant="ghost" size="sm" href="/dashboard/admin/periods">
            Períodos
          </Button>
        {/if}
      {/if}
      {#if canEdit || (activeTab === "inventory" && auth.isAdmin)}
        <Button size="sm" onclick={openCreatePage}>
          {#if activeTab === "inventory"}
            Nuevo producto base
          {:else if activeTab === "gaso"}
            Nuevo paquete GASO
          {:else}
            Nueva oferta FNB
          {/if}
        </Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if offersTab && currentPeriod && currentPeriod.status !== "draft" && auth.canEditCatalog}
    <Banner tone="warning" class="mb-4">
      Este período está {currentPeriod.status === "active" ? "activo" : "archivado"}. Sus ofertas
      no se pueden modificar.
    </Banner>
  {/if}

  <Tabs bind:value={activeTab}>
    <TabsList>
      <TabsTrigger value="inventory">Inventario (base)</TabsTrigger>
      <TabsTrigger value="gaso">Gasodomésticos (bundles)</TabsTrigger>
      <TabsTrigger value="fnb">Financiera (FNB)</TabsTrigger>
    </TabsList>

    <TabsContent value="inventory">
      <InventoryGrid
        products={baseProducts}
        canEdit={auth.isAdmin}
        onProductClick={handleProductClick}
      />
    </TabsContent>

    <TabsContent value="gaso">
      {#if !currentPeriod}
        {@render noPeriod()}
      {:else if bundles.length === 0}
        <EmptyState title="Sin paquetes" description="Este período no tiene paquetes configurados." />
      {:else}
        <BundleGrid
          {bundles}
          {canEdit}
          onBundleClick={handleBundleClick}
          onStockUpdate={handleStockUpdate}
        />
      {/if}
    </TabsContent>

    <TabsContent value="fnb">
      {#if !currentPeriod}
        {@render noPeriod()}
      {:else if fnbBundles.length === 0}
        <EmptyState title="Sin ofertas FNB" description="Este período no tiene ofertas FNB configuradas." />
      {:else}
        <BundleGrid
          bundles={fnbBundles}
          {canEdit}
          onBundleClick={handleFnbBundleClick}
          onStockUpdate={handleStockUpdate}
        />
      {/if}
    </TabsContent>
  </Tabs>
</Page>
