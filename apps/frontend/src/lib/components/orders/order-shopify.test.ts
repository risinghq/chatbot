/// <reference types="bun" />

import { describe, it, expect } from "bun:test";
import "../../testing/svelte-ssr.ts";
import { render } from "svelte/server";
import type { OrderDetail } from "@vendeya/types";

function order(fields: Partial<OrderDetail>): OrderDetail {
  return fields as OrderDetail;
}

async function show(orderDetail: OrderDetail) {
  const { default: Shopify } = await import("./order-shopify.svelte");
  return render(Shopify, { props: { order: orderDetail } }).body;
}

describe("the order's Shopify state", () => {
  it("shows a failed write-back with its error", async () => {
    const body = await show(
      order({
        shopify_order_id: null,
        shopify_sync: {
          status: "failed",
          last_error: "Shopify answered 500",
          next_attempt_at: 1_700_018_000_000,
          attempts: 2,
        },
      }),
    );

    expect(body).toContain("Error al crear el pedido en Shopify");
    expect(body).toContain("Shopify answered 500");
  });

  it("shows the Shopify id the order was written back as", async () => {
    const body = await show(
      order({
        shopify_order_id: "612001",
        shopify_sync: {
          status: "synced",
          last_error: null,
          next_attempt_at: 0,
          attempts: 1,
        },
      }),
    );

    expect(body).toContain("#612001");
    expect(body).toContain("Sincronizado");
  });

  it("renders nothing without a connection", async () => {
    const body = await show(
      order({ shopify_order_id: null, shopify_sync: null }),
    );

    expect(body).not.toContain("Shopify");
  });
});
