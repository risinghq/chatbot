<script lang="ts">
import { untrack } from "svelte";
import { invalidateAll } from "$app/navigation";
import type {
  Audience,
  CampaignSummary,
  MessageTemplate,
  ParamBinding,
  ParamField,
} from "@vendeya/types";
import { PARAM_FIELDS, TEMPLATE_LANGUAGES } from "@vendeya/types";
import PageHeader from "#lib/components/shared/page-header.svelte";
import Page from "#lib/components/shared/page.svelte";
import PageTitle from "#lib/components/shared/page-title.svelte";
import Badge from "#lib/components/ui/badge.svelte";
import Button from "#lib/components/ui/button.svelte";
import DataTable from "#lib/components/ui/data-table.svelte";
import EmptyState from "#lib/components/ui/empty-state.svelte";
import { fieldStyles } from "#lib/components/ui/field-styles.js";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Modal from "#lib/components/ui/modal.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import Select from "#lib/components/ui/select.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { toast } from "#lib/state/toast.svelte.js";
import { ApiError, fetchApi } from "#lib/utils/api.js";
import { formatCents } from "#lib/utils/money.js";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();

const canWrite = $derived(auth.canManageCampaigns);

const TEMPLATE_STATUS: Record<
  string,
  {
    label: string;
    variant: "default" | "success" | "warning" | "error";
  }
> = {
  pending: { label: "Pendiente", variant: "warning" },
  approved: { label: "Aprobada", variant: "success" },
  rejected: { label: "Rechazada", variant: "error" },
  paused: { label: "Pausada", variant: "default" },
  disabled: { label: "Deshabilitada", variant: "default" },
};

const CAMPAIGN_STATUS: Record<string, string> = {
  scheduled: "Programada",
  sending: "Enviando",
  sent: "Enviada",
  failed: "Fallida",
  cancelled: "Cancelada",
};

const FIELD_LABELS: Record<ParamField, string> = {
  customer_name: "Nombre del cliente",
  order_number: "Número de pedido",
  order_total: "Total del pedido",
  pay_link: "Link de pago",
};

// --- Template form -----------------------------------------------------------

let templateOpen = $state(false);
let templateName = $state("");
let templateLanguage = $state<string>("es");
let templateCategory = $state<"marketing" | "utility">("marketing");
let templateBody = $state("");
let templateParams = $state<
  { mode: "text" | "field"; text: string; field: ParamField }[]
>([]);
let templateError = $state("");
let savingTemplate = $state(false);

function templatePlaceholders(body: string): number[] {
  const found = new Set<number>();
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

$effect(() => {
  const needed = templatePlaceholders(templateBody).length;
  while (templateParams.length < needed) {
    templateParams.push({ mode: "field", text: "", field: "customer_name" });
  }
  templateParams.length = needed;
});

async function createTemplate() {
  templateError = "";
  savingTemplate = true;
  try {
    const params: ParamBinding[] = templateParams.map((p) =>
      p.mode === "field"
        ? { kind: "field", field: p.field }
        : { kind: "text", text: p.text },
    );
    await fetchApi("/api/campaigns/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: templateName.trim(),
        language: templateLanguage,
        category: templateCategory,
        body: templateBody,
        params,
      }),
    });
    templateOpen = false;
    toast.success("Plantilla enviada a Meta para revisión");
    await invalidateAll();
  } catch (error) {
    templateError =
      error instanceof ApiError
        ? error.message
        : "No se pudo registrar la plantilla";
  } finally {
    savingTemplate = false;
  }
}

// --- Campaign form -----------------------------------------------------------

let campaignOpen = $state(false);
let campaignName = $state("");
let campaignTemplateId = $state("");
let audienceKind = $state<Audience["kind"]>("all");
let audienceCategory = $state("");
let audienceProductId = $state("");
let audienceDays = $state(45);
let audiencePhones = $state("");
let audienceCount = $state<number | null>(null);
let sendMode = $state<"now" | "later">("now");
let scheduledAt = $state("");
let campaignError = $state("");
let savingCampaign = $state(false);
let countTimer: ReturnType<typeof setTimeout> | null = null;

const approvedTemplates = $derived(
  data.templates.filter((t) => t.status === "approved"),
);
const selectedTemplate = $derived(
  data.templates.find((t) => t.id === campaignTemplateId),
);

function audience(): Audience | null {
  switch (audienceKind) {
    case "all":
      return { kind: "all" };
    case "category":
      return audienceCategory.trim()
        ? { kind: "category", category: audienceCategory.trim() }
        : null;
    case "product":
      return audienceProductId.trim()
        ? { kind: "product", product_id: audienceProductId.trim() }
        : null;
    case "inactive":
      return { kind: "inactive", days: audienceDays };
    case "phones": {
      const phones = audiencePhones
        .split(/[\s,;]+/)
        .map((p) => p.trim())
        .filter(Boolean);
      return phones.length > 0 ? { kind: "phones", phones } : null;
    }
  }
}

function recount() {
  audienceCount = null;
  if (countTimer) clearTimeout(countTimer);
  countTimer = setTimeout(async () => {
    const a = audience();
    if (!a) return;
    try {
      const res = await fetchApi<{ count: number }>(
        "/api/campaigns/audience-count",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audience: a }),
        },
      );
      audienceCount = res.count;
    } catch {
      audienceCount = null;
    }
  }, 300);
}

async function createCampaign() {
  campaignError = "";
  const a = audience();
  if (!a) {
    campaignError = "Completa la audiencia";
    return;
  }
  let scheduled_at: number | null = null;
  if (sendMode === "later") {
    const at = new Date(scheduledAt).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) {
      campaignError = "Elige una fecha y hora futura";
      return;
    }
    scheduled_at = at;
  }
  savingCampaign = true;
  try {
    await fetchApi("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: campaignName.trim(),
        template_id: campaignTemplateId,
        audience: a,
        scheduled_at,
      }),
    });
    campaignOpen = false;
    toast.success("Campaña programada");
    await invalidateAll();
  } catch (error) {
    campaignError =
      error instanceof ApiError ? error.message : "No se pudo crear la campaña";
  } finally {
    savingCampaign = false;
  }
}

async function cancelCampaign(campaign: CampaignSummary) {
  try {
    await fetchApi(`/api/campaigns/${campaign.id}/cancel`, { method: "POST" });
    toast.success("Campaña cancelada");
    await invalidateAll();
  } catch {
    toast.error("No se pudo cancelar la campaña");
  }
}

// --- Reminders ---------------------------------------------------------------

const reminderFields = (r: PageData["reminders"]) => ({
  cartEnabled: r.abandoned_cart.enabled,
  cartHours: r.abandoned_cart.hours,
  cartTemplateId: r.abandoned_cart.template_id ?? "",
  inactiveEnabled: r.inactive.enabled,
  inactiveDays: r.inactive.days,
  inactiveTemplateId: r.inactive.template_id ?? "",
  marketingDays: r.marketing_min_interval_days,
});

let synced = reminderFields(data.reminders);
const reminders = $state(reminderFields(data.reminders));
let savingReminders = $state(false);

// Refreshed data replaces a field only while it still holds its last-loaded
// value; a field the user edited keeps what they typed.
$effect(() => {
  const next = reminderFields(data.reminders);
  untrack(() => {
    const fields: Record<keyof typeof next, unknown> = reminders;
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (fields[key] === synced[key]) fields[key] = next[key];
    }
    synced = next;
  });
});

async function saveReminders() {
  savingReminders = true;
  try {
    await fetchApi("/api/campaigns/settings/reminders", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        abandoned_cart: {
          enabled: reminders.cartEnabled,
          hours: reminders.cartHours,
          template_id: reminders.cartTemplateId || null,
        },
        inactive: {
          enabled: reminders.inactiveEnabled,
          days: reminders.inactiveDays,
          template_id: reminders.inactiveTemplateId || null,
        },
        marketing_min_interval_days: reminders.marketingDays,
      }),
    });
    toast.success("Recordatorios guardados");
    await invalidateAll();
  } catch (error) {
    toast.error(
      error instanceof ApiError
        ? error.message
        : "No se pudieron guardar los recordatorios",
    );
  } finally {
    savingReminders = false;
  }
}

function formatDate(at: number | null): string {
  if (at === null) return "–";
  return new Date(at).toLocaleString("es-PE", {
    dateStyle: "short",
    timeStyle: "short",
  });
}
</script>

<PageTitle title="Campañas" />

<Page>
	<PageHeader title="Campañas" subtitle="Mensajes de WhatsApp para grupos de clientes y recordatorios automáticos.">
		{#snippet actions()}
			{#if canWrite}
				<Button variant="secondary" onclick={() => (templateOpen = true)}>Nueva plantilla</Button>
				<Button onclick={() => (campaignOpen = true)}>Nueva campaña</Button>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="flex flex-col gap-6">
		<SectionShell title="Plantillas" description="Las plantillas que Meta aprobó se pueden enviar fuera de la ventana de 24 horas.">
		{#if data.templates.length === 0}
			<EmptyState title="Sin plantillas" description="Registra la primera plantilla; Meta la aprueba antes de poder usarla." />
		{:else}
			<DataTable
				data={data.templates}
				keyField="id"
				columns={[
					{ header: "Nombre", cell: tplName },
					{ header: "Categoría", cell: tplCategory },
					{ header: "Estado", cell: tplStatus },
					{ header: "Cuerpo", cell: tplBody },
				]}
			/>
		{/if}
	</SectionShell>

		<SectionShell title="Campañas" description="Envíos programados y enviados con sus resultados.">
		{#if data.campaigns.length === 0}
			<EmptyState title="Sin campañas" description="Crea una campaña para escribir a un grupo de clientes con una plantilla aprobada." />
		{:else}
			<DataTable
				data={data.campaigns}
				keyField="id"
				columns={[
					{ header: "Campaña", cell: campName },
					{ header: "Estado", cell: campStatus },
					{ header: "Envío", cell: campWhen },
					{ header: "Destinados", cell: campTargeted, align: "right" },
					{ header: "Enviados", cell: campSent, align: "right" },
					{ header: "Entr. / Leídos", cell: campDeliveredRead, align: "right" },
					{ header: "Resp.", cell: campReplied, align: "right" },
					{ header: "Pedidos (7d)", cell: campOrders, align: "right" },
					{ header: "", cell: campActions },
				]}
			/>
		{/if}
	</SectionShell>

		{#if canWrite}
			<SectionShell title="Recordatorios" description="Mensajes automáticos sobre pedidos pendientes y clientes inactivos.">
			<form class="grid gap-4 p-4" onsubmit={(e) => { e.preventDefault(); saveReminders(); }}>
				<div class="grid gap-3">
					<label class="flex items-center gap-2 text-sm text-fg">
						<input type="checkbox" bind:checked={reminders.cartEnabled} />
						Recordatorio de carrito abandonado
					</label>
					<div class="grid max-w-md grid-cols-2 gap-3">
						<FormField label="Horas sin respuesta" for="cart-hours">
							<Input id="cart-hours" type="number" bind:value={reminders.cartHours} disabled={!reminders.cartEnabled} />
						</FormField>
						<FormField label="Plantilla" for="cart-template">
							<Select
								id="cart-template"
								bind:value={reminders.cartTemplateId}
								disabled={!reminders.cartEnabled}
								items={approvedTemplates.map((t) => ({ value: t.id, label: t.name }))}
							/>
						</FormField>
					</div>
				</div>

				<div class="grid gap-3 border-t border-border-subtle pt-4">
					<label class="flex items-center gap-2 text-sm text-fg">
						<input type="checkbox" bind:checked={reminders.inactiveEnabled} />
						Cliente inactivo
					</label>
					<div class="grid max-w-md grid-cols-2 gap-3">
						<FormField label="Días sin comprar" for="inactive-days">
							<Input id="inactive-days" type="number" bind:value={reminders.inactiveDays} disabled={!reminders.inactiveEnabled} />
						</FormField>
						<FormField label="Plantilla" for="inactive-template">
							<Select
								id="inactive-template"
								bind:value={reminders.inactiveTemplateId}
								disabled={!reminders.inactiveEnabled}
								items={approvedTemplates.map((t) => ({ value: t.id, label: t.name }))}
							/>
						</FormField>
					</div>
				</div>

				<div class="border-t border-border-subtle pt-4">
					<FormField label="Un cliente recibe marketing como máximo cada (días)" for="marketing-days">
						<Input id="marketing-days" type="number" bind:value={reminders.marketingDays} class="max-w-32" />
					</FormField>
				</div>

				<div>
					<Button type="submit" disabled={savingReminders}>{savingReminders ? "Guardando…" : "Guardar recordatorios"}</Button>
				</div>
			</form>
			</SectionShell>
		{/if}
	</div>
</Page>

<Modal bind:open={templateOpen} title="Nueva plantilla" onClose={() => (templateOpen = false)}>
	<div class="grid gap-4">
		<FormField label="Nombre (minúsculas y guiones bajos)" for="tpl-name">
			<Input id="tpl-name" bind:value={templateName} placeholder="promo_marzo" />
		</FormField>
		<div class="grid grid-cols-2 gap-3">
			<FormField label="Idioma" for="tpl-lang">
				<Select id="tpl-lang" bind:value={templateLanguage} items={TEMPLATE_LANGUAGES.map((l) => ({ value: l, label: l }))} />
			</FormField>
			<FormField label="Categoría" for="tpl-cat">
				<Select
					id="tpl-cat"
					bind:value={templateCategory}
					items={[
						{ value: "marketing", label: "Marketing" },
						{ value: "utility", label: "Utilidad" },
					]}
				/>
			</FormField>
		</div>
		<FormField label="Cuerpo, con {'{1}'}, {'{2}'}… como parámetros" for="tpl-body">
			<Textarea id="tpl-body" bind:value={templateBody} rows={4} placeholder="Hola {'{1}'}, tenemos una oferta para ti." />
		</FormField>
		{#each templateParams as param, i}
			<div class="grid grid-cols-[auto_1fr] items-center gap-2">
				<span class="font-mono text-sm text-fg-muted">{"{{" + (i + 1) + "}}"}</span>
				<div class="grid grid-cols-2 gap-2">
					<Select
						bind:value={param.mode}
						items={[
							{ value: "field", label: "Campo del cliente o pedido" },
							{ value: "text", label: "Texto fijo" },
						]}
					/>
					{#if param.mode === "field"}
						<Select
							bind:value={param.field}
							items={PARAM_FIELDS.map((f) => ({ value: f, label: FIELD_LABELS[f] }))}
						/>
					{:else}
						<Input bind:value={param.text} placeholder="Texto fijo" />
					{/if}
				</div>
			</div>
		{/each}
		{#if templateError}
			<p class="text-sm text-danger">{templateError}</p>
		{/if}
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (templateOpen = false)} disabled={savingTemplate}>Cancelar</Button>
		<Button onclick={createTemplate} disabled={savingTemplate || !templateName.trim() || !templateBody.trim()}>
			{savingTemplate ? "Registrando…" : "Registrar en Meta"}
		</Button>
	{/snippet}
</Modal>

<Modal bind:open={campaignOpen} title="Nueva campaña" onClose={() => (campaignOpen = false)}>
	<div class="grid gap-4">
		<FormField label="Nombre" for="camp-name">
			<Input id="camp-name" bind:value={campaignName} placeholder="Oferta de marzo" />
		</FormField>
		<FormField label="Plantilla aprobada" for="camp-tpl">
			<Select
				id="camp-tpl"
				bind:value={campaignTemplateId}
				items={approvedTemplates.map((t) => ({ value: t.id, label: `${t.name} (${t.category})` }))}
			/>
		</FormField>
		{#if selectedTemplate}
			<p class="rounded-md bg-surface-subtle p-3 text-sm text-fg-muted">{selectedTemplate.body}</p>
		{/if}

		<FormField label="Audiencia" for="camp-aud">
			<Select
				id="camp-aud"
				bind:value={audienceKind}
				onchange={recount}
				items={[
					{ value: "all", label: "Todos los clientes" },
					{ value: "category", label: "Compraron una categoría" },
					{ value: "product", label: "Compraron un producto" },
					{ value: "inactive", label: "Inactivos" },
					{ value: "phones", label: "Lista de teléfonos" },
				]}
			/>
		</FormField>
		{#if audienceKind === "category"}
			<FormField label="Categoría" for="aud-cat">
				<Input id="aud-cat" bind:value={audienceCategory} oninput={recount} placeholder="Bebidas" />
			</FormField>
		{:else if audienceKind === "product"}
			<FormField label="Id del producto" for="aud-prod">
				<Input id="aud-prod" bind:value={audienceProductId} oninput={recount} />
			</FormField>
		{:else if audienceKind === "inactive"}
			<FormField label="Días sin actividad" for="aud-days">
				<Input id="aud-days" type="number" bind:value={audienceDays} oninput={recount} />
			</FormField>
		{:else if audienceKind === "phones"}
			<FormField label="Teléfonos, separados por coma o línea" for="aud-phones">
				<Textarea id="aud-phones" bind:value={audiencePhones} oninput={recount} rows={3} placeholder="51999888777, 51911222333" />
			</FormField>
		{/if}
		<p class="text-sm text-fg-muted">
			{#if audienceCount === null}Audiencia: —{:else}Audiencia: {audienceCount} clientes{/if}
		</p>

		<FormField label="Envío" for="camp-when">
			<Select
				id="camp-when"
				bind:value={sendMode}
				items={[
					{ value: "now", label: "Ahora" },
					{ value: "later", label: "Programar" },
				]}
			/>
		</FormField>
		{#if sendMode === "later"}
			<FormField label="Fecha y hora" for="camp-at">
				<input id="camp-at" type="datetime-local" bind:value={scheduledAt} class="{fieldStyles(false)} h-11" />
			</FormField>
		{/if}
		{#if campaignError}
			<p class="text-sm text-danger">{campaignError}</p>
		{/if}
	</div>
	{#snippet footer()}
		<Button variant="secondary" onclick={() => (campaignOpen = false)} disabled={savingCampaign}>Cancelar</Button>
		<Button onclick={createCampaign} disabled={savingCampaign || !campaignName.trim() || !campaignTemplateId}>
			{savingCampaign ? "Creando…" : "Crear campaña"}
		</Button>
	{/snippet}
</Modal>

{#snippet tplName(t: MessageTemplate)}
	<span class="font-medium text-fg">{t.name}</span>
	<div class="text-sm text-fg-muted">{t.language}</div>
{/snippet}

{#snippet tplCategory(t: MessageTemplate)}
	{t.category === "marketing" ? "Marketing" : "Utilidad"}
{/snippet}

{#snippet tplStatus(t: MessageTemplate)}
	{@const s = TEMPLATE_STATUS[t.status] ?? { label: t.status, variant: "default" as const }}
	<Badge variant={s.variant}>{s.label}</Badge>
{/snippet}

{#snippet tplBody(t: MessageTemplate)}
	<span class="text-sm text-fg-muted">{t.body}</span>
{/snippet}

{#snippet campName(c: CampaignSummary)}
	<span class="font-medium text-fg">{c.name}</span>
	<div class="text-sm text-fg-muted">{c.template_name ?? ""}</div>
{/snippet}

{#snippet campStatus(c: CampaignSummary)}
	{CAMPAIGN_STATUS[c.status] ?? c.status}
{/snippet}

{#snippet campWhen(c: CampaignSummary)}
	<span class="whitespace-nowrap">{formatDate(c.status === "scheduled" ? c.scheduled_at : c.sent_at)}</span>
{/snippet}

{#snippet campTargeted(c: CampaignSummary)}<span class="tabular-nums">{c.results.targeted}</span>{/snippet}
{#snippet campSent(c: CampaignSummary)}<span class="tabular-nums">{c.results.sent}</span>{/snippet}
{#snippet campDeliveredRead(c: CampaignSummary)}<span class="whitespace-nowrap tabular-nums">{c.results.delivered} / {c.results.read}</span>{/snippet}
{#snippet campReplied(c: CampaignSummary)}<span class="tabular-nums">{c.results.replied}</span>{/snippet}

{#snippet campOrders(c: CampaignSummary)}
	<span class="whitespace-nowrap tabular-nums">{c.results.orders} · S/ {formatCents(c.results.orders_total_cents)}</span>
{/snippet}

{#snippet campActions(c: CampaignSummary)}
	{#if c.status === "scheduled" && canWrite}
		<Button size="sm" variant="secondary" onclick={() => cancelCampaign(c)}>Cancelar</Button>
	{/if}
{/snippet}
