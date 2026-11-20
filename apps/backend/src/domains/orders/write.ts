import { newId } from "@vendeya/utils";
import type { Order } from "@vendeya/types";
import { limaDateString } from "../../db/query.ts";
import { eventBus } from "../../shared/events/index.ts";
import { createTraceId } from "@vendeya/utils";
import { getOrderById } from "./read.ts";
import type { CreateOrderInput } from "./types.ts";
import { run } from "../../db/index.ts";

const ORDER_NUMBER_SEQUENCE_WIDTH = 3;

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const { ref } = input;
  const id = newId();
  const now = Date.now();
  const productJson = JSON.stringify(input.products);
  const mainProduct = input.products[0];

  // The sequence is read and the row written by one statement, which D1 runs
  // alone, so two orders created at once cannot take the same number.
  const datePrefix = `ORD-${limaDateString(now).replaceAll("-", "")}-`;
  const suffixStart = datePrefix.length + 1;
  await run(
    `INSERT INTO orders (
       id, tenant_id, channel_account_id, order_number, conversation_phone,
       client_name, client_dni, products, total_amount, delivery_address,
       delivery_reference, status, assigned_agent, created_at, updated_at
     )
     SELECT ?, ?, ?,
       ? || printf('%0${ORDER_NUMBER_SEQUENCE_WIDTH}d', COALESCE(MAX(CAST(SUBSTR(order_number, ?) AS INTEGER)), 0) + 1),
       ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
     FROM orders
     WHERE tenant_id = ?
       AND order_number LIKE ?
       AND SUBSTR(order_number, ?) NOT GLOB '*[^0-9]*'`,
    [
      id,
      ref.tenantId,
      ref.channelAccountId,
      datePrefix,
      suffixStart,
      ref.phoneNumber,
      input.clientName,
      input.clientDni,
      productJson,
      input.totalAmount,
      input.deliveryAddress,
      input.deliveryReference || null,
      input.assignedAgent || null,
      now,
      now,
      ref.tenantId,
      `${datePrefix}%`,
      suffixStart,
    ],
  );

  const order = await getOrderById(ref.tenantId, id);
  if (!order) {
    throw new Error(`Failed to create order ${id}`);
  }

  await eventBus.emit({
    type: "order_created",
    traceId: createTraceId(),
    timestamp: Date.now(),
    tenantId: ref.tenantId,
    channelAccountId: ref.channelAccountId,
    payload: {
      orderId: id,
      orderNumber: order.order_number,
      amount: input.totalAmount,
      clientName: input.clientName,
      phoneNumber: ref.phoneNumber,
      dni: input.clientDni,
      productName: mainProduct?.name || "Producto",
    },
  });

  return order;
}

export async function updateOrderStatus(
  tenantId: string,
  id: string,
  status: string,
  notes?: string,
  noteType?: "supervisor" | "calidda",
): Promise<Order> {
  const now = Date.now();
  let query = "UPDATE orders SET status = ?, updated_at = ?";
  const params: any[] = [status, now];

  if (notes && noteType) {
    const column =
      noteType === "supervisor" ? "supervisor_notes" : "calidda_notes";
    query += `, ${column} = ?`;
    params.push(notes);
  }

  query += " WHERE id = ? AND tenant_id = ?";
  params.push(id, tenantId);

  await run(query, params);

  const order = await getOrderById(tenantId, id);
  if (!order) {
    throw new Error(`Failed to update order ${id}`);
  }

  return order;
}
