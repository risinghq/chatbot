import {
  limaDateString,
  limaDayBounds,
  tenantPredicate,
} from "../../db/query.ts";
import * as XLSX from "xlsx";
import type { OrderStatus, PaymentState } from "@vendeya/types";
import { OrderReads } from "../orders/index.ts";
import { getAll, getOne } from "../../db/index.ts";

type ActivityReportParams = {
  /**
   * Null spans open tenants. Only an unpinned platform operator's request
   * passes it.
   */
  tenantId: string | null;
  startDate: Date;
  endDate: Date;
  segments: string[];
  saleStatuses: string[];
};

type OrderReportParams = {
  tenantId: string | null;
  startDate?: Date;
  endDate?: Date;
  status?: OrderStatus;
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

export const ReportService = {
  /** `date` is `YYYY-MM-DD` in Lima. Omitted, it is today there. */
  generateDailyReport: async (tenantId: string | null, date?: string) => {
    const [start, end] = limaDayBounds(date);

    const rows = await getAll<Record<string, unknown>>(
      `
            SELECT
              phone_number,
              client_name,
              dni,
              segment,
              credit_line,
              status,
              current_state,
              last_activity_at
            FROM conversations
            WHERE last_activity_at BETWEEN ? AND ?
              AND ${tenantPredicate(tenantId)}
        `,
      tenantId ? [start, end, tenantId] : [start, end],
    );

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, limaDateString(start));

    return XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
    }) as ArrayBuffer;
  },

  generateActivityReport: async (params: ActivityReportParams) => {
    const { tenantId, startDate, endDate, segments, saleStatuses } = params;

    const conditions: string[] = ["is_simulation = 0"];
    const values: any[] = [];

    conditions.push(tenantPredicate(tenantId));
    if (tenantId) values.push(tenantId);

    const startTimestamp = startDate.getTime();
    const endTimestamp = endDate.getTime();
    conditions.push("last_activity_at >= ? AND last_activity_at <= ?");
    values.push(startTimestamp, endTimestamp);

    if (segments.length > 0 && !segments.includes("all")) {
      const segmentConditions: string[] = [];
      if (segments.includes("fnb")) segmentConditions.push("segment = 'fnb'");
      if (segments.includes("gaso")) segmentConditions.push("segment = 'gaso'");
      if (segments.includes("none")) segmentConditions.push("segment IS NULL");
      if (segmentConditions.length > 0) {
        conditions.push(`(${segmentConditions.join(" OR ")})`);
      }
    }

    if (saleStatuses.length > 0 && !saleStatuses.includes("all")) {
      const statusPlaceholders = saleStatuses.map(() => "?").join(",");
      conditions.push(`sale_status IN (${statusPlaceholders})`);
      values.push(...saleStatuses);
    }

    const whereClause = conditions.join(" AND ");

    const rows = await getAll<Record<string, unknown>>(
      `
        SELECT
          phone_number as "Teléfono",
          client_name as "Nombre",
          dni as "DNI",
          segment as "Campaña",
          credit_line as "Crédito",
          nse as "NSE",
          current_state as "Estado Bot",
          sale_status as "Estado Venta",
          agent_notes as "Observaciones",
          products_interested as "Productos",
          last_activity_at as "Última Actividad"
        FROM conversations
        WHERE ${whereClause}
        ORDER BY last_activity_at DESC
      `,
      values,
    );

    const transformedRows = rows.map((row, index) => {
      let productos = "";
      try {
        const productsArray = JSON.parse((row.Productos as string) || "[]");
        if (Array.isArray(productsArray) && productsArray.length > 0) {
          productos = productsArray.join(", ");
        }
      } catch {
        productos = (row.Productos as string) || "";
      }

      let fechaActividad = "";
      if (row["Última Actividad"]) {
        const timestamp = Number(row["Última Actividad"]);
        if (!Number.isNaN(timestamp)) {
          fechaActividad = new Date(timestamp).toLocaleString("es-PE", {
            timeZone: "America/Lima",
          });
        } else {
          fechaActividad = row["Última Actividad"] as string;
        }
      }

      const saleStatusMap: Record<string, string> = {
        pending: "Pendiente",
        confirmed: "Confirmado",
        rejected: "Rechazado",
        no_answer: "Sin respuesta",
      };

      const segmentMap: Record<string, string> = {
        fnb: "FNB",
        gaso: "GASO",
      };

      return {
        "#": index + 1,
        Teléfono: row.Teléfono,
        Nombre: row.Nombre || "",
        DNI: row.DNI || "",
        Campaña: segmentMap[row.Campaña as string] || "",
        Crédito: row.Crédito || "",
        NSE: row.NSE || "",
        "Estado Venta":
          saleStatusMap[row["Estado Venta"] as string] || "Pendiente",
        Productos: productos,
        Observaciones: row.Observaciones || "",
        "Última Actividad": fechaActividad,
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(transformedRows);

    // Set column widths
    worksheet["!cols"] = [
      { wch: 5 }, // #
      { wch: 15 }, // Teléfono
      { wch: 25 }, // Nombre
      { wch: 12 }, // DNI
      { wch: 8 }, // Campaña
      { wch: 10 }, // Crédito
      { wch: 5 }, // NSE
      { wch: 12 }, // Estado Venta
      { wch: 30 }, // Productos
      { wch: 40 }, // Observaciones
      { wch: 20 }, // Última Actividad
    ];

    const workbook = XLSX.utils.book_new();
    const sheetName = limaDateString(startTimestamp);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    return XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
    }) as ArrayBuffer;
  },

  getTodayContactCount: async (tenantId: string | null) => {
    const [startTimestamp] = limaDayBounds();

    const result = await getOne<{ count: number }>(
      `
        SELECT COUNT(*) as count
        FROM conversations
        WHERE is_simulation = 0 AND last_activity_at >= ?
          AND ${tenantPredicate(tenantId)}
      `,
      tenantId ? [startTimestamp, tenantId] : [startTimestamp],
    );

    return result?.count ?? 0;
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
      Fecha: new Date(order.created_at).toLocaleString("es-PE", {
        timeZone: "America/Lima",
      }),
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [10, 25, 15, 12, 10, 12, 10, 12, 12, 10, 20].map(
      (wch) => ({ wch }),
    );

    const workbook = XLSX.utils.book_new();
    const sheetName = startDate
      ? limaDateString(startDate.getTime())
      : "Ordenes";
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    return XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
    }) as ArrayBuffer;
  },
};
