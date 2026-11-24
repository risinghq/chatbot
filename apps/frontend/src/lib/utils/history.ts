import type {
  HistoryActor,
  HistoryEntry,
  HistorySubject,
} from "@vendeya/types";
import { limaDateString } from "#lib/utils/formatters.js";
import { formatCents } from "#lib/utils/money.js";
import { orderStatusLabel } from "#lib/utils/order-status.js";
import { roleLabel } from "#lib/utils/roles.js";

/** A subject as the sentence shows it: its name, and its page when it has one. */
export type SubjectLink = { label: string; href: string | null };

/**
 * One history entry as a sentence: `{actor} {verb} {subject} {tail}`.
 * `quote` is text the actor wrote, shown under the sentence.
 */
export type Phrase = {
  actor: string;
  verb: string;
  subject: SubjectLink | null;
  tail: string;
  quote: string | null;
  unconfirmed: boolean;
};

/** A run of entries on one Lima calendar day, newest first. */
export type HistoryDay = {
  key: string;
  title: string;
  entries: HistoryEntry[];
};

/**
 * Where the page is: inside a business, whose records have pages under
 * `/dashboard/{tenantId}`, or on the platform, where only businesses do.
 */
export type HistoryPlace = { tenantId: string } | { platform: true };

export function actorName(actor: HistoryActor): string {
  if (actor.kind === "terminal") return `${actor.name} (terminal)`;
  return actor.name ?? "Un usuario sin nombre";
}

/** What a subject is called when its record is gone and nothing named it. */
const UNNAMED: Record<string, string> = {
  order: "un pedido",
  customer: "un cliente",
  product: "un producto",
  conversation: "una conversación",
  user: "un usuario",
  channel_account: "un número",
  delivery_zone: "una zona de envío",
  payment_method: "un método de pago",
  stock_location: "una ubicación",
  invitation: "una invitación",
  api_token: "un token",
  tenant: "un negocio",
  assistant_settings: "asistente",
};

const SECTION: Record<string, (id: string) => string> = {
  order: (id) => `/orders/${id}`,
  customer: (id) => `/clientes/${id}`,
  product: (id) => `/catalog/inventory/${id}`,
  conversation: (id) => `/conversations/${id}`,
  user: (id) => `/admin/users/${id}`,
  channel_account: () => "/admin/channels",
  delivery_zone: () => "/admin/orders",
  payment_method: () => "/admin/orders",
  stock_location: () => "/inventario",
  invitation: () => "/admin/users",
  assistant_settings: () => "/asistente",
};

export function subjectHref(
  subject: HistorySubject,
  place: HistoryPlace,
): string | null {
  if (subject.type === "tenant") return `/dashboard/${subject.id}`;
  if ("platform" in place) return null;
  const section = SECTION[subject.type];
  return section ? `/dashboard/${place.tenantId}${section(subject.id)}` : null;
}

function link(entry: HistoryEntry, place: HistoryPlace): SubjectLink | null {
  const subject = entry.subject;
  if (!subject) return null;
  const label = subject.label ?? UNNAMED[subject.type] ?? "algo";
  // A deleted record has no page to open.
  const gone = entry.action.startsWith("delete_") && subject.type !== "product";
  return { label, href: gone ? null : subjectHref(subject, place) };
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const amount = (value: unknown): string =>
  typeof value === "number" ? `S/ ${formatCents(value)}` : "";
const count = (value: unknown): number =>
  typeof value === "number" ? Math.abs(value) : 0;

type Words = { verb: string; tail?: string; hide?: boolean };

function stockWords(details: Record<string, unknown>): Words {
  const n = count(details.quantity);
  const units = n === 1 ? "1 unidad" : `${n} unidades`;
  switch (details.kind) {
    case "receive":
      return { verb: `recibió ${units} de` };
    case "reserve":
      return { verb: `reservó ${units} de` };
    case "release":
      return { verb: `liberó ${units} de` };
    case "ship":
      return { verb: `despachó ${units} de` };
    default: {
      const q = typeof details.quantity === "number" ? details.quantity : 0;
      return { verb: "ajustó el stock de", tail: `en ${q > 0 ? "+" : ""}${q}` };
    }
  }
}

function words(entry: HistoryEntry): Words {
  const d = entry.details;
  const as = (role: unknown) => `como ${roleLabel(text(role)).toLowerCase()}`;
  switch (entry.action) {
    case "create_product":
      return { verb: "creó el producto" };
    case "update_product":
      return { verb: "editó el producto" };
    case "add_product_image":
      return { verb: "agregó una foto a" };
    case "reorder_product_images":
      return { verb: "reordenó las fotos de" };
    case "delete_product_image":
      return { verb: "quitó una foto de" };
    case "create_variant":
      return {
        verb: d.sku
          ? `agregó la variante ${text(d.sku)} a`
          : "agregó una variante a",
      };
    case "update_variant":
      return { verb: "editó una variante de" };
    case "record_stock_movement":
      return stockWords(d);
    case "create_stock_location":
      return { verb: "creó la ubicación" };
    case "create_delivery_zone":
      return { verb: "creó la zona de envío" };
    case "update_delivery_zone":
      return { verb: "editó la zona de envío" };
    case "delete_delivery_zone":
      return { verb: "borró la zona de envío" };
    case "create_payment_method":
      return { verb: "creó el método de pago" };
    case "update_payment_method":
      return { verb: "editó el método de pago" };
    case "delete_payment_method":
      return { verb: "borró el método de pago" };
    case "create_order":
      return {
        verb: "creó el pedido",
        tail: d.total_cents === undefined ? "" : `por ${amount(d.total_cents)}`,
      };
    case "transition_order":
      return {
        verb: "pasó el pedido",
        tail: `a ${orderStatusLabel(text(d.status)).toLowerCase()}`,
      };
    case "add_payment":
      return {
        verb: `registró un pago${d.amount_cents === undefined ? "" : ` de ${amount(d.amount_cents)}`} en el pedido`,
      };
    case "confirm_payment":
      return { verb: "confirmó un pago del pedido" };
    case "reject_payment":
      return { verb: "rechazó un pago del pedido" };
    case "update_shipment":
      return { verb: "actualizó el envío del pedido" };
    case "create_customer":
      return { verb: "agregó al cliente" };
    case "update_customer":
      return { verb: "editó al cliente" };
    case "delete_customer":
      return { verb: "borró al cliente" };
    case "export_replay":
      return { verb: "llevó al simulador la conversación con" };
    case "takeover": {
      const n = count(d.cancelledReplies);
      return {
        verb: "tomó la conversación con",
        tail:
          n === 0
            ? ""
            : `y detuvo ${n === 1 ? "1 respuesta" : `${n} respuestas`} del asistente`,
      };
    }
    case "release":
      return { verb: "devolvió al asistente la conversación con" };
    case "send_message":
      return { verb: "escribió a" };
    case "decline_assignment":
      return { verb: "rechazó la conversación con" };
    case "create_channel_account":
      return { verb: "conectó el número" };
    case "update_channel_account":
      return { verb: "editó el número" };
    case "create_invitation":
      return { verb: "invitó a", tail: as(d.role) };
    case "revoke_invitation":
      return { verb: "anuló la invitación de" };
    case "accept_invitation":
      return { verb: "se unió al equipo", tail: as(d.role), hide: true };
    case "grant_membership":
      return { verb: "dio acceso a", tail: as(d.role) };
    case "remove_membership":
      return { verb: "quitó el acceso a" };
    case "update_user_role":
      return {
        verb: "cambió el rol de",
        tail: `a ${roleLabel(text(d.newRole)).toLowerCase()}`,
      };
    case "toggle_user_status":
      return { verb: d.newStatus === "active" ? "activó a" : "desactivó a" };
    case "reset_password":
      return { verb: "restableció la contraseña de" };
    case "create_user":
      return { verb: "creó la cuenta de" };
    case "promote_platform_operator":
      return { verb: "hizo operador de la plataforma a" };
    case "update_profile":
      return { verb: "editó su perfil", hide: true };
    case "change_password":
      return { verb: "cambió su contraseña", hide: true };
    case "sign_up":
      return { verb: "se registró y creó el negocio" };
    case "create_tenant":
      return { verb: "creó el negocio" };
    case "select_tenant":
      return { verb: "entró al negocio" };
    case "update_settings":
      return { verb: "cambió los ajustes del negocio", hide: true };
    case "update_assistant_settings":
      return { verb: "cambió la configuración del" };
    case "update_platform_settings":
      return { verb: "cambió los ajustes de la plataforma", hide: true };
    // Revokes before the name was recorded have nothing to name.
    case "create_api_token":
      return entry.subject?.label
        ? { verb: "creó el token de API" }
        : { verb: "creó un token de API", hide: true };
    case "revoke_api_token":
      return entry.subject?.label
        ? { verb: "revocó el token de API" }
        : { verb: "revocó un token de API", hide: true };
    default:
      return { verb: `hizo «${entry.action.replaceAll("_", " ")}» en` };
  }
}

export function phrase(entry: HistoryEntry, place: HistoryPlace): Phrase {
  const w = words(entry);
  const subject = w.hide ? null : link(entry, place);
  const message =
    entry.action === "send_message" ? text(entry.details.message) : "";
  return {
    actor: actorName(entry.actor),
    verb: w.verb,
    subject,
    tail: w.tail ?? "",
    quote: message || null,
    unconfirmed: entry.details.deliveryUnconfirmed === true,
  };
}

const DAY_TITLE = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const DAY_MS = 86_400_000;

/** Splits entries, newest first, into Lima days titled Hoy, Ayer or the date. */
export function byDay(entries: HistoryEntry[], now = Date.now()): HistoryDay[] {
  const today = limaDateString(now);
  const yesterday = limaDateString(now - DAY_MS);
  const days: HistoryDay[] = [];
  for (const entry of entries) {
    const key = limaDateString(entry.at);
    let day = days.at(-1);
    if (day?.key !== key) {
      const title =
        key === today
          ? "Hoy"
          : key === yesterday
            ? "Ayer"
            : capitalize(DAY_TITLE.format(entry.at));
      day = { key, title, entries: [] };
      days.push(day);
    }
    day.entries.push(entry);
  }
  return days;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
