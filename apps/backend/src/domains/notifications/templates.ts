import { publicOrigin } from "../../config.ts";

export type NotificationContext = {
  /** The business the alert is about. Its dashboard pages live under its id. */
  tenantId?: string;
  phoneNumber: string;
  /**
   * The number the conversation is on. A conversation is (tenant, channel
   * account, phone number), so a link without it is ambiguous when the contact
   * has threads on more than one number.
   */
  channelAccountId?: string | null;
  clientName?: string | null;
  dni?: string | null;
  details?: string;
  urlSuffix?: string;
};

/** A page of the alert's business. An alert with no business links nowhere. */
function formatLink(ctx: NotificationContext, suffix?: string): string {
  if (!suffix || !ctx.tenantId) return "";
  return `${publicOrigin()}/dashboard/${ctx.tenantId}${suffix}`;
}

/**
 * The link carries the channel account, as the inbox's own links do. A contact
 * writing to two of the tenant's numbers has two threads, and the API answers a
 * bare phone number with a 409 "Ambiguous conversation" instead of guessing.
 */
function conversationLink(ctx: NotificationContext): string {
  const query = ctx.channelAccountId
    ? `?channel=${encodeURIComponent(ctx.channelAccountId)}`
    : "";

  return formatLink(ctx, `/conversations/${ctx.phoneNumber}${query}`);
}

function b(text: string): string {
  return `*${text}*`;
}

export const templates = {
  assignment(ctx: NotificationContext): string {
    const ident = b(ctx.clientName || ctx.phoneNumber);
    const dniContext = ctx.dni ? ` (${ctx.dni})` : "";

    return [
      `${ident}${dniContext} espera atención.`,
      ctx.urlSuffix ? formatLink(ctx, ctx.urlSuffix) : conversationLink(ctx),
    ].join("\n");
  },

  newOrder(
    ctx: NotificationContext,
    orderNumber: string,
    amountCents: number,
    productName?: string,
  ): string {
    const ident = b(ctx.clientName || ctx.phoneNumber);
    const dniContext = ctx.dni ? ` (${ctx.dni})` : "";
    const money = b(`S/ ${(amountCents / 100).toFixed(2)}`);
    const product = productName ? ` Escogió: ${productName}` : "";

    return [
      `${ident}${dniContext} generó orden ${b(orderNumber)} por ${money}.${product}`,
      formatLink(ctx, ctx.urlSuffix),
    ].join("\n");
  },

  escalation(ctx: NotificationContext, reason: string): string {
    const ident = b(ctx.clientName || ctx.phoneNumber);
    const dniContext = ctx.dni ? ` (${ctx.dni})` : "";

    return [
      `${ident}${dniContext} requiere atención.`,
      `Motivo: ${reason}`,
      ctx.urlSuffix ? formatLink(ctx, ctx.urlSuffix) : conversationLink(ctx),
    ].join("\n");
  },

  customerMessage(ctx: NotificationContext): string {
    const ident = b(ctx.clientName || ctx.phoneNumber);

    return [
      `${ident} escribió en la conversación que atiendes.`,
      ctx.urlSuffix ? formatLink(ctx, ctx.urlSuffix) : conversationLink(ctx),
    ].join("\n");
  },

  systemError(ctx: NotificationContext, error: string): string {
    const ident = b(ctx.phoneNumber);
    return [
      `Se ha producido un error con el ${ident}. Error: ${error}`,
      `Conversación: ${conversationLink(ctx)}`,
      `Registro del asistente: ${formatLink(ctx, "/asistente/registro")}`,
    ].join("\n");
  },

  systemOutage(ctx: NotificationContext, errors: string[]): string {
    const ident = ctx.dni || "Unknown";
    return [
      `Proveedores no están funcionando. Cliente con DNI ${ident} se vio afectado.`,
      `Errors: ${errors.join(", ")}`,
      // Removed link as requested
    ].join("\n");
  },

  degradation(
    ctx: NotificationContext,
    failed: string,
    working: string,
  ): string {
    const ident = ctx.dni || "Unknown";
    return [
      `Proveedor *${failed}* está teniendo problemas. Se está usando *${working}* para el cliente con DNI ${ident}`,
      // Removed link as requested
    ].join("\n");
  },
};
