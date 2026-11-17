import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { batch, stmt } from "../src/db/index.ts";
import { createOrder } from "../src/domains/orders/write.ts";
import {
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

const DATE = "20261010";
const orderNumber = (sequence: number) =>
  `ORD-${DATE}-${String(sequence).padStart(3, "0")}`;

const ORDER = {
  clientName: "Cliente",
  clientDni: "12345678",
  products: [{ productId: "p1", name: "Terma", price: 900, quantity: 1 }],
  totalAmount: 900,
  deliveryAddress: "Av. Siempre Viva 123",
};

describe("order number sequence", () => {
  let firstTenant: TenantFixture;
  let secondTenant: TenantFixture;

  beforeEach(async () => {
    firstTenant = await createTenantFixture("order-sequence-first");
    secondTenant = await createTenantFixture("order-sequence-second");
    await insertConversation(firstTenant.ref("51900000001"));
    await insertConversation(secondTenant.ref("51900000002"));
    vi.setSystemTime(new Date("2026-10-11T02:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The day already holds 996 orders, so the orders created at once cross the
   * three-digit width. Each takes the next number, none repeats, and another
   * tenant's sequence starts over.
   */
  it("continues past 999 without a repeat and resets for another tenant", async () => {
    const now = Date.now();
    await batch(
      Array.from({ length: 996 }, (_, index) =>
        stmt(
          `INSERT INTO orders (id, tenant_id, channel_account_id, order_number,
             conversation_phone, client_name, client_dni, products, total_amount,
             delivery_address, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, '51900000001', 'Cliente', '12345678', '[]', 900,
             'Av. Siempre Viva 123', 'pending', ?, ?)`,
          [
            crypto.randomUUID(),
            firstTenant.tenantId,
            firstTenant.channelAccountId,
            orderNumber(index + 1),
            now,
            now,
          ],
        ),
      ),
    );

    const created = await Promise.all(
      Array.from({ length: 8 }, () =>
        createOrder({ ...ORDER, ref: firstTenant.ref("51900000001") }),
      ),
    );

    expect(created.map((order) => order.order_number).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => orderNumber(997 + index)).sort(),
    );

    const secondTenantOrder = await createOrder({
      ...ORDER,
      ref: secondTenant.ref("51900000002"),
    });
    expect(secondTenantOrder.order_number).toBe(orderNumber(1));
  });
});
