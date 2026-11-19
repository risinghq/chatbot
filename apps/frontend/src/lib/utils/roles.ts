import type { UserRole } from "@vendeya/types";

export const roleLabels: Record<UserRole, string> = {
  admin: "Administrador",
  developer: "Desarrollador",
  supervisor: "Supervisor",
  sales_agent: "Agente de ventas",
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "Sin rol en el negocio";
  return roleLabels[role as UserRole] ?? role;
}
