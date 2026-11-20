import type { OrderStatus, PaymentState, PaymentStatus } from "@vendeya/types";

type BadgeVariant =
  | "default"
  | "success"
  | "error"
  | "warning"
  | "info"
  | "accent";

export const orderStatusLabels: Record<OrderStatus, string> = {
  pending: "Pendiente",
  confirmed: "Confirmado",
  packed: "Empacado",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const statusVariants: Record<OrderStatus, BadgeVariant> = {
  pending: "warning",
  confirmed: "info",
  packed: "accent",
  shipped: "accent",
  delivered: "success",
  cancelled: "default",
};

export function orderStatusLabel(status: string): string {
  return orderStatusLabels[status as OrderStatus] ?? status;
}

export function orderStatusVariant(status: string): BadgeVariant {
  return statusVariants[status as OrderStatus] ?? "default";
}

/**
 * The button that moves an order to a status. `delivered` from `packed` is
 * a pickup, so it says so.
 */
export function transitionLabel(from: OrderStatus, to: OrderStatus): string {
  if (to === "delivered" && from === "packed") return "Entregado en tienda";
  const labels: Record<OrderStatus, string> = {
    pending: "Pendiente",
    confirmed: "Confirmar",
    packed: "Marcar empacado",
    shipped: "Marcar enviado",
    delivered: "Marcar entregado",
    cancelled: "Cancelar pedido",
  };
  return labels[to];
}

export const paymentStateLabels: Record<PaymentState, string> = {
  unpaid: "Sin pagar",
  partial: "Pago parcial",
  paid: "Pagado",
};

export function paymentStateVariant(state: PaymentState): BadgeVariant {
  return state === "paid"
    ? "success"
    : state === "partial"
      ? "info"
      : "warning";
}

export const paymentStatusLabels: Record<PaymentStatus, string> = {
  pending: "Por confirmar",
  confirmed: "Confirmado",
  rejected: "Rechazado",
};

export function paymentStatusVariant(status: PaymentStatus): BadgeVariant {
  return status === "confirmed"
    ? "success"
    : status === "rejected"
      ? "error"
      : "warning";
}

/** Orders are numbered per business from 1001; people read them with a #. */
export function orderLabel(number: number): string {
  return `#${number}`;
}
