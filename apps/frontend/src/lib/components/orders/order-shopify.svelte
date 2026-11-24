<script lang="ts">
import type { OrderDetail, ShopifyOrderSync } from "@vendeya/types";
import { formatDateTime } from "#lib/utils/formatters.js";

let { order }: { order: OrderDetail } = $props();

const syncLabels: Record<ShopifyOrderSync["status"], string> = {
  pending: "Pendiente de envío",
  sending: "Enviándose",
  synced: "Sincronizado",
  failed: "Error al crear el pedido en Shopify",
};
</script>

{#if order.shopify_order_id || order.shopify_sync}
  <section class="p-4">
    <h2 class="mb-3 text-md font-medium text-fg">Shopify</h2>
    <dl class="grid grid-cols-1 gap-3">
      {#if order.shopify_order_id}
        <div>
          <dt class="text-sm text-fg-muted">Pedido en Shopify</dt>
          <dd class="mt-0.5 text-fg tabular-nums font-mono">#{order.shopify_order_id}</dd>
        </div>
      {/if}
      {#if order.shopify_sync}
        {@const sync = order.shopify_sync}
        <div>
          <dt class="text-sm text-fg-muted">Estado</dt>
          <dd class="mt-0.5 text-fg">{syncLabels[sync.status]}</dd>
        </div>
        {#if sync.status === "failed"}
          {#if sync.last_error}
            <div>
              <dt class="text-sm text-fg-muted">Error</dt>
              <dd class="mt-0.5 text-fg">{sync.last_error}</dd>
            </div>
          {/if}
          <div>
            <dt class="text-sm text-fg-muted">Reintento</dt>
            <dd class="mt-0.5 text-fg">{sync.attempts} {sync.attempts === 1 ? "intento" : "intentos"} · próximo {formatDateTime(sync.next_attempt_at)}</dd>
          </div>
        {/if}
      {/if}
    </dl>
  </section>
{/if}
