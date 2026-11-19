import type { OrderStatus } from "@vendeya/types";

export const orderStatusLabels: Record<OrderStatus, string> = {
  pending: "Pendiente",
  supervisor_approved: "Aprobado por supervisor",
  supervisor_rejected: "Rechazado por supervisor",
  calidda_approved: "Aprobado por Calidda",
  calidda_rejected: "Rechazado por Calidda",
  delivered: "Entregado",
};

type BadgeVariant =
  | "default"
  | "success"
  | "error"
  | "warning"
  | "info"
  | "accent";

const variants: Record<OrderStatus, BadgeVariant> = {
  pending: "warning",
  supervisor_approved: "info",
  supervisor_rejected: "error",
  calidda_approved: "success",
  calidda_rejected: "error",
  delivered: "default",
};

export function orderStatusLabel(status: string): string {
  return orderStatusLabels[status as OrderStatus] ?? status;
}

export function orderStatusVariant(status: string): BadgeVariant {
  return variants[status as OrderStatus] ?? "default";
}
