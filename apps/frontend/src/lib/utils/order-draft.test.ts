/// <reference types="bun" />

import { describe, it, expect } from "bun:test";
import type { DeliveryZone, StockRow } from "@vendeya/types";
import {
  addVariant,
  draftProblems,
  draftTotals,
  emptyDraft,
  orderBody,
  withAvailability,
} from "./order-draft.ts";

const POLO: StockRow = {
  variant_id: "v1",
  sku: "POLO-M",
  variant_name: "M",
  product_id: "p1",
  product_name: "Polo",
  price_cents: 4990,
  is_active: 1,
  on_hand: 3,
  reserved: 0,
  available: 3,
};

const ZONE: DeliveryZone = {
  id: "z1",
  tenant_id: "t1",
  name: "Miraflores",
  fee_cents: 1000,
  is_active: 1,
  created_at: 0,
};

describe("an order draft", () => {
  it("adds a variant once and counts its units on one line", () => {
    const lines = addVariant(addVariant([], POLO), POLO);

    expect(lines).toEqual([
      {
        variantId: "v1",
        label: "Polo · M",
        sku: "POLO-M",
        price: "49.90",
        quantity: 2,
        available: 3,
      },
    ]);
  });

  it("charges the zone's fee on a shipment and none on a pickup", () => {
    const draft = {
      ...emptyDraft("c1"),
      lines: addVariant([], POLO),
      delivery: "ship" as const,
      zoneId: "z1",
    };

    expect(draftTotals(draft, [ZONE])).toEqual({
      subtotal: 4990,
      fee: 1000,
      total: 5990,
    });
    expect(draftTotals({ ...draft, delivery: "pickup" }, [ZONE]).total).toBe(
      4990,
    );
  });

  it("names what is missing before it can be sent", () => {
    const draft = {
      ...emptyDraft(),
      lines: addVariant([], { ...POLO, available: 0 }),
      delivery: "ship" as const,
      fee: "diez",
    };

    expect(draftProblems(draft, [])).toEqual([
      "Elige el cliente",
      "Solo quedan 0 de Polo · M",
      "Escribe la dirección",
      "Revisa el costo de envío",
    ]);
  });

  it("re-reads availability when the location changes", () => {
    const lines = withAvailability(addVariant([], POLO), [
      { ...POLO, available: 1 },
    ]);
    expect(lines[0]?.available).toBe(1);
    expect(withAvailability(lines, [])[0]?.available).toBe(0);
  });

  it("sends a typed fee only when no zone sets it", () => {
    const draft = {
      ...emptyDraft("c1"),
      lines: addVariant([], POLO),
      delivery: "ship" as const,
      fee: "7.50",
      address: {
        line: " Jr. Puno 4 ",
        district: "",
        city: "Lima",
        reference: "",
      },
    };

    expect(orderBody(draft, [])).toEqual({
      customer_id: "c1",
      lines: [{ variant_id: "v1", quantity: 1, unit_price_cents: 4990 }],
      location_id: null,
      shipment: {
        zone_id: null,
        fee_cents: 750,
        address_line: "Jr. Puno 4",
        district: null,
        city: "Lima",
        reference: null,
      },
      notes: null,
    });
    expect(
      orderBody({ ...draft, zoneId: "z1" }, [ZONE]).shipment,
    ).not.toHaveProperty("fee_cents");
  });
});
