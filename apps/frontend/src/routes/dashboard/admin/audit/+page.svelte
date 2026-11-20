<script lang="ts">
import { onMount } from "svelte";
import { fetchApi } from "#lib/utils/api.js";
import { formatDateTime } from "#lib/utils/formatters.js";
import type { AuditLog } from "@vendeya/types";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import Button from "#lib/components/ui/button.svelte";
import Badge from "#lib/components/ui/badge.svelte";

type AuditLogWithName = AuditLog & {
  user_name?: string;
  user_email?: string | null;
};
let logs = $state<AuditLogWithName[]>([]);
let loading = $state(true);

const actionLabels: Record<string, string> = {
  create_user: "Creó usuario",
  promote_platform_operator: "Promovió a operador de plataforma",
  toggle_user_status: "Cambió estado",
  update_user_role: "Cambió rol",
  reset_password: "Reseteó password",
  update_settings: "Configuración",
  create_order: "Registró pedido",
  transition_order: "Movió pedido",
  add_payment: "Registró pago",
  confirm_payment: "Confirmó pago",
  reject_payment: "Rechazó pago",
  update_shipment: "Actualizó envío",
  create_customer: "Creó cliente",
  update_customer: "Actualizó cliente",
  delete_customer: "Eliminó cliente",
  create_delivery_zone: "Creó zona de envío",
  update_delivery_zone: "Actualizó zona de envío",
  delete_delivery_zone: "Eliminó zona de envío",
  create_payment_method: "Creó método de pago",
  update_payment_method: "Actualizó método de pago",
  delete_payment_method: "Eliminó método de pago",
  create_product: "Creó producto",
  update_product: "Actualizó producto",
  delete_product: "Eliminó producto",
  bulk_update_products: "Actualización masiva",
  send_message: "Envió mensaje",
};

function isUnconfirmed(item: AuditLogWithName): boolean {
  if (item.action !== "send_message") return false;
  try {
    return JSON.parse(item.metadata).deliveryUnconfirmed === true;
  } catch {
    return false;
  }
}

async function loadLogs() {
  loading = true;
  try {
    const res = await fetchApi<{ logs: AuditLogWithName[] }>(
      "/api/admin/audit?limit=100",
    );
    logs = res.logs;
  } catch (e) {
    console.error(e);
  } finally {
    loading = false;
  }
}

onMount(loadLogs);

const columns = [
  { header: "Fecha", cell: dateCell },
  { header: "Usuario", cell: userCell },
  { header: "Acción", cell: actionCell },
  { header: "Recurso", cell: resourceCell },
  { header: "Detalles", cell: detailsCell },
];
</script>

<SectionShell title="Registro de auditoría" description="Últimos 100 eventos del negocio." action={refreshAction}>
	<DataTable data={logs} {columns} {loading} emptyMessage="No hay registros de auditoría recientes." />
</SectionShell>

{#snippet refreshAction()}
	<Button size="sm" variant="secondary" onclick={loadLogs} disabled={loading}>
		{loading ? "Cargando…" : "Actualizar"}
	</Button>
{/snippet}

{#snippet dateCell(item: AuditLogWithName)}
	<span class="text-sm whitespace-nowrap text-fg-muted tabular-nums">{formatDateTime(item.created_at)}</span>
{/snippet}

{#snippet userCell(item: AuditLogWithName)}
	<div class="text-fg">{item.user_name || item.actor}</div>
	{#if item.user_email}
		<div class="text-sm text-fg-muted">{item.user_email}</div>
	{/if}
{/snippet}

{#snippet actionCell(item: AuditLogWithName)}
	<Badge>{actionLabels[item.action] || item.action}</Badge>
{/snippet}

{#snippet resourceCell(item: AuditLogWithName)}
	<div class="text-sm text-fg">{item.resource_type}</div>
	<div class="font-mono text-sm text-fg-muted">{item.resource_id || "—"}</div>
{/snippet}

{#snippet detailsCell(item: AuditLogWithName)}
	{#if !item.metadata || item.metadata === "{}"}
		<span class="text-fg-subtle">—</span>
	{:else}
		{#if isUnconfirmed(item)}
			<Badge variant="warning" class="mb-1">Entrega sin confirmar</Badge>
			<span class="sr-only">: WhatsApp no confirmó el mensaje; puede que el cliente no lo recibiera.</span>
		{/if}
		<code class="block max-w-xs truncate rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-xs text-fg-muted" title={item.metadata}>{item.metadata}</code>
	{/if}
{/snippet}
