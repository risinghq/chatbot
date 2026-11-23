import * as XLSX from "xlsx";
import type {
  ConversationStatus,
  OrderStatus,
  PaymentState,
} from "@vendeya/types";
import { limaDateString, limaDayBounds } from "../../db/query.ts";
import { db, tenantScope } from "../../db/index.ts";
import { OrderReads } from "../orders/index.ts";

type ActivityReportParams = {
  tenantId: string;
  startDate: Date;
  endDate: Date;
};

type OrderReportParams = {
  tenantId: string;
  startDate?: Date;
  endDate?: Date;
  status?: OrderStatus;
};

const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  active: "Asistente",
  human_takeover: "Equipo",
  closed: "Cerrada",
};

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Pendiente",
  confirmed: "Confirmado",
  packed: "Empacado",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  unpaid: "Sin pagar",
  partial: "Pago parcial",
  paid: "Pagado",
};

const limaTime = (ms: number) =>
  new Date(ms).toLocaleString("es-PE", { timeZone: "America/Lima" });

function workbookOf(
  rows: Record<string, unknown>[],
  widths: number[],
  sheetName: string,
): ArrayBuffer {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = widths.map((wch) => ({ wch }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;
}

export const ReportService = {
  /**
   * Every customer who wrote in the range, with who answers them now. The
   * customer's name is the business's customer with the same phone number.
   */
  generateActivityReport: async (params: ActivityReportParams) => {
    const { tenantId, startDate, endDate } = params;

    const conversations = await db
      .selectFrom("conversations as cv")
      .leftJoin("users as u", "u.id", "cv.assigned_agent")
      .select((eb) => [
        "cv.phone_number",
        "cv.status",
        "cv.handover_reason",
        "cv.last_activity_at",
        "u.name as agent_name",
        eb
          .selectFrom("customers as c")
          .select("c.name")
          .whereRef("c.tenant_id", "=", "cv.tenant_id")
          .whereRef("c.phone", "=", "cv.phone_number")
          .limit(1)
          .as("customer_name"),
      ])
      .where(tenantScope(tenantId, "cv.tenant_id"))
      .where("cv.is_simulation", "=", 0)
      .where("cv.last_activity_at", ">=", startDate.getTime())
      .where("cv.last_activity_at", "<=", endDate.getTime())
      .orderBy("cv.last_activity_at", "desc")
      .execute();

    const rows = conversations.map((conv, index) => ({
      "#": index + 1,
      Teléfono: conv.phone_number,
      Cliente: conv.customer_name ?? "",
      Atiende: CONVERSATION_STATUS_LABELS[conv.status as ConversationStatus],
      Agente: conv.agent_name ?? "",
      "Motivo de derivación": conv.handover_reason ?? "",
      "Última actividad": limaTime(conv.last_activity_at),
    }));

    return workbookOf(
      rows,
      [5, 15, 25, 10, 20, 30, 20],
      limaDateString(startDate.getTime()),
    );
  },

  getTodayContactCount: async (tenantId: string) => {
    const [startTimestamp] = limaDayBounds();
    const row = await db
      .selectFrom("conversations")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where(tenantScope(tenantId))
      .where("is_simulation", "=", 0)
      .where("last_activity_at", ">=", startTimestamp)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  },

  generateOrderReport: async (params: OrderReportParams) => {
    const { tenantId, startDate, endDate, status } = params;
    const orders = await OrderReads.list(tenantId, {
      status,
      startMs: startDate?.getTime(),
      endMs: endDate?.getTime(),
    });

    const soles = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`;
    const rows = orders.map((order) => ({
      Pedido: order.number,
      Cliente: order.customer_name,
      Teléfono: order.customer_phone ?? "",
      Estado: ORDER_STATUS_LABELS[order.status],
      Pago: PAYMENT_STATE_LABELS[order.payment_state],
      Subtotal: soles(order.subtotal_cents),
      Envío: soles(order.delivery_fee_cents),
      Total: soles(order.total_cents),
      Pagado: soles(order.paid_cents),
      Origen: order.source === "assistant" ? "Asistente" : "Equipo",
      Fecha: limaTime(order.created_at),
    }));

    return workbookOf(
      rows,
      [10, 25, 15, 12, 10, 12, 10, 12, 12, 10, 20],
      startDate ? limaDateString(startDate.getTime()) : "Ordenes",
    );
  },
};
