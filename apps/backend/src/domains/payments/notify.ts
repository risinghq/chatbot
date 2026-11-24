import type { OrderDetail } from "@vendeya/types";
import {
  ChannelUnavailableError,
  WhatsAppService,
} from "../../adapters/whatsapp/index.ts";
import { createLogger } from "../../lib/logger.ts";

const logger = createLogger("payment-notify");

function soles(cents: number): string {
  return `S/ ${(cents / 100).toFixed(2)}`;
}

/**
 * Tells the customer, in the chat the order came from, that the payment
 * arrived. An order staff entered has no chat and gets no message.
 */
export async function tellCustomerPaid(
  order: OrderDetail,
  amountCents: number,
): Promise<void> {
  if (!order.channel_account_id || !order.customer_phone) return;
  const ref = {
    tenantId: order.tenant_id,
    channelAccountId: order.channel_account_id,
    phoneNumber: order.customer_phone,
  };
  const left = order.total_cents - order.paid_cents;
  const text =
    left > 0
      ? `Recibimos tu pago de ${soles(amountCents)} del pedido #${order.number}. Falta ${soles(left)}.`
      : `¡Gracias! Recibimos tu pago de ${soles(amountCents)}. El pedido #${order.number} está pagado.`;
  try {
    await WhatsAppService.sendMessage(ref, text, { retry: true });
  } catch (error) {
    if (!(error instanceof ChannelUnavailableError)) throw error;
    logger.warn(
      { orderId: order.id },
      "The order's number is off; the customer was not told the payment arrived",
    );
  }
}
