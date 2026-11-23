/**
 * The assistant's tools read the business's catalog, stock, zones and
 * payment methods, and file an order for the customer of the chat. A
 * simulated chat reads the same data and writes nothing. Every tool sees
 * only its own business. A business with a Cálidda login also checks a
 * customer's Cálidda credit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProductVariant } from "@vendeya/types";

import { db } from "./helpers/db.ts";
import { AssistantSettingsService } from "../src/domains/assistant/settings.ts";
import {
  runTool,
  toolsFor,
  type ToolContext,
} from "../src/domains/assistant/tools/index.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import { VariantService } from "../src/domains/catalog/variants.ts";
import { CustomerService } from "../src/domains/customers/index.ts";
import { eligibilityHandler } from "../src/domains/eligibility/index.ts";
import {
  DeliveryZoneService,
  PaymentMethodService,
} from "../src/domains/orders/index.ts";
import { StockService } from "../src/domains/stock/index.ts";
import { Ok } from "../src/shared/result/index.ts";
import { createTenantFixture } from "./helpers/tenancy.ts";

const PHONE = "51987654321";
const TOOLS = toolsFor({ caliddaCredit: true });

async function addVariant(
  tenantId: string,
  product: {
    name: string;
    category: string;
    brand?: string;
    status?: "draft" | "active";
  },
  variant: { name: string | null; price_cents: number; stock: number },
): Promise<ProductVariant> {
  const p = await ProductService.create({ tenantId, ...product });
  const v = await VariantService.create(tenantId, p.id, {
    name: variant.name,
    sku: `SKU-${crypto.randomUUID().slice(0, 8)}`,
    price_cents: variant.price_cents,
    cost_cents: null,
    is_active: 1,
  });
  if (variant.stock > 0) {
    const location = await StockService.defaultLocation(tenantId);
    await StockService.record({
      tenantId,
      variantId: v.id,
      locationId: location!.id,
      kind: "receive",
      quantity: variant.stock,
      createdBy: null,
    });
  }
  return v;
}

describe("the assistant's tools", () => {
  let ctx: ToolContext;
  let polo: ProductVariant;
  let zoneId: string;
  let methodId: string;

  async function call(
    name: string,
    args: object = {},
    over: Partial<ToolContext> = {},
  ) {
    return await runTool(TOOLS, { ...ctx, ...over }, name, args);
  }

  async function orderCount(): Promise<number> {
    const rows = await db
      .selectFrom("orders")
      .select("id")
      .where("tenant_id", "=", ctx.tenantId)
      .execute();
    return rows.length;
  }

  beforeEach(async () => {
    const fixture = await createTenantFixture("assistant-tools");
    ctx = {
      tenantId: fixture.tenantId,
      channelAccountId: fixture.channelAccountId,
      phone: PHONE,
      simulated: false,
    };
    polo = await addVariant(
      ctx.tenantId,
      { name: "Polo algodón", category: "ropa", brand: "Andes" },
      { name: "M", price_cents: 4990, stock: 3 },
    );
    await addVariant(
      ctx.tenantId,
      { name: "Gorra lona", category: "accesorios" },
      { name: null, price_cents: 2500, stock: 0 },
    );
    await addVariant(
      ctx.tenantId,
      { name: "Polo borrador", category: "ropa", status: "draft" },
      { name: "S", price_cents: 1000, stock: 9 },
    );
    zoneId = (
      await DeliveryZoneService.create(ctx.tenantId, {
        name: "Miraflores",
        fee_cents: 1000,
      })
    ).id;
    methodId = (
      await PaymentMethodService.create(ctx.tenantId, {
        name: "Yape",
        instructions: "Yapea al 999 888 777",
      })
    ).id;
  });

  it("give every tool a strict schema that lists each argument as required", () => {
    for (const tool of TOOLS) {
      expect(tool.parameters.additionalProperties, tool.name).toBe(false);
      expect([...tool.parameters.required].sort(), tool.name).toEqual(
        Object.keys(tool.parameters.properties).sort(),
      );
    }
  });

  describe("search_products", () => {
    it("finds active products by every word, with lowest price and availability", async () => {
      const { result } = await call("search_products", { query: "polo andes" });
      expect(result).toEqual({
        products: [
          expect.objectContaining({
            name: "Polo algodón",
            price_from: "S/ 49.90",
            available: true,
          }),
        ],
      });
    });

    it("lists every active product for a null query and leaves drafts out", async () => {
      const { result } = (await call("search_products", { query: null })) as {
        result: { products: { name: string; available: boolean }[] };
      };
      expect(result.products.map((p) => [p.name, p.available])).toEqual([
        ["Gorra lona", false],
        ["Polo algodón", true],
      ]);
    });

    it("treats % and _ as plain characters", async () => {
      const { result } = await call("search_products", { query: "%" });
      expect(result).toEqual({ products: [] });
    });
  });

  it("get_product gives each variant's id, price and units available", async () => {
    const { result } = await call("get_product", {
      product_id: polo.product_id,
    });
    expect(result).toMatchObject({
      name: "Polo algodón",
      photos: 0,
      variants: [
        { variant_id: polo.id, name: "M", price: "S/ 49.90", available: 3 },
      ],
    });
  });

  it("send_product_photos refuses a product with no photos", async () => {
    const outcome = await call("send_product_photos", {
      product_id: polo.product_id,
    });
    expect(outcome).toEqual({
      result: { error: "the product has no photos" },
      effects: [],
    });
  });

  it("quote prices the lines and adds the zone's fee", async () => {
    const { result } = await call("quote", {
      lines: [{ variant_id: polo.id, quantity: 4 }],
      zone_id: zoneId,
    });
    expect(result).toMatchObject({
      lines: [{ line_total: "S/ 199.60", enough_stock: false }],
      delivery_zone: "Miraflores",
      delivery_fee: "S/ 10.00",
      total: "S/ 209.60",
    });
  });

  it("returns argument mistakes and unknown tools to the model as errors", async () => {
    expect((await call("quote", { lines: [], zone_id: null })).result).toEqual({
      error: "lines must list at least one product variant",
    });
    expect((await call("nope")).result).toEqual({
      error: "there is no tool named nope",
    });
  });

  describe("create_order", () => {
    const order = (extra: object = {}) => ({
      customer_name: "Ana Torres",
      document_type: "dni",
      document_number: "12345678",
      lines: [{ variant_id: polo.id, quantity: 2 }],
      address: {
        line: "Av. Larco 123",
        district: "Miraflores",
        city: "Lima",
        reference: null,
      },
      zone_id: zoneId,
      payment_method_id: methodId,
      notes: null,
      ...extra,
    });

    it("files the order for the chat's phone, holds stock and records the chosen payment", async () => {
      const outcome = await call("create_order", order());

      expect(outcome.result).toMatchObject({
        status: "pending",
        total: "S/ 109.80",
        payment_method: "Yape",
        payment_instructions: "Yapea al 999 888 777",
      });
      const effect = outcome.effects[0];
      expect(effect?.kind).toBe("order_created");
      if (effect?.kind !== "order_created") return;
      expect(effect.order).toMatchObject({
        source: "assistant",
        channel_account_id: ctx.channelAccountId,
        customer: {
          name: "Ana Torres",
          phone: PHONE,
          document_number: "12345678",
        },
        shipment: expect.objectContaining({ address_line: "Av. Larco 123" }),
        payments: [
          expect.objectContaining({ amount_cents: 10980, status: "pending" }),
        ],
      });
      const [row] = await StockService.levels(ctx.tenantId, undefined, [
        polo.product_id,
      ]);
      expect(row).toMatchObject({ on_hand: 3, reserved: 2 });

      const { result } = await call("get_customer");
      expect(result).toMatchObject({
        customer: {
          name: "Ana Torres",
          addresses: [{ line: "Av. Larco 123" }],
        },
      });
    });

    it("saves an address once however many orders use it", async () => {
      await call(
        "create_order",
        order({ lines: [{ variant_id: polo.id, quantity: 1 }] }),
      );
      await call(
        "create_order",
        order({ lines: [{ variant_id: polo.id, quantity: 1 }] }),
      );
      const customer = await CustomerService.getByPhone(ctx.tenantId, PHONE);
      expect(
        await CustomerService.addresses(ctx.tenantId, customer!.id),
      ).toHaveLength(1);
    });

    it("asks for a zone when a delivery names none", async () => {
      const { result } = await call("create_order", order({ zone_id: null }));
      expect(result).toEqual({
        error: "a delivery needs zone_id: call list_delivery_zones",
      });
    });

    it("refuses more than the stock and files nothing", async () => {
      const { result } = await call(
        "create_order",
        order({ lines: [{ variant_id: polo.id, quantity: 4 }] }),
      );
      expect(result).toEqual({ error: "not enough stock for this order" });
      expect(await orderCount()).toBe(0);
    });

    it("refuses a draft product's variant", async () => {
      const draft = await db
        .selectFrom("product_variants")
        .select("id")
        .where("tenant_id", "=", ctx.tenantId)
        .where("price_cents", "=", 1000)
        .executeTakeFirstOrThrow();
      const { result } = await call(
        "create_order",
        order({ lines: [{ variant_id: draft.id, quantity: 1 }] }),
      );
      expect(result).toEqual({ error: `variant ${draft.id} is not for sale` });
    });

    it("in a simulation, returns the order it would file and writes nothing", async () => {
      const outcome = await call("create_order", order(), { simulated: true });

      expect(outcome.effects).toEqual([]);
      expect(outcome.result).toMatchObject({
        simulated: true,
        total: "S/ 109.80",
      });
      expect(await orderCount()).toBe(0);
      expect(await CustomerService.getByPhone(ctx.tenantId, PHONE)).toBeNull();
    });

    it("sells from the location the settings name when the business has several", async () => {
      const second = await StockService.createLocation(
        ctx.tenantId,
        "Tienda 2",
      );
      const first = await call(
        "create_order",
        order({ lines: [{ variant_id: polo.id, quantity: 1 }] }),
      );
      expect(first.result).toMatchObject({
        error: expect.stringContaining("hand the order off"),
      });

      await AssistantSettingsService.update(
        ctx.tenantId,
        { stock_location_id: second!.id },
        null,
      );
      const { result } = await call(
        "create_order",
        order({ lines: [{ variant_id: polo.id, quantity: 1 }] }),
      );
      expect(result).toEqual({ error: "not enough stock for this order" });
    });
  });

  describe("check_calidda_credit", () => {
    let execute: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      execute = vi.spyOn(eligibilityHandler, "execute");
    });

    afterEach(() => {
      execute.mockRestore();
    });

    it("gives the credit line and keeps the name and NSE from the model", async () => {
      execute.mockResolvedValue(
        Ok({
          status: "eligible",
          source: "powerbi",
          credit: 3500,
          name: "JUAN PEREZ",
          nse: 3,
        }) as never,
      );

      const { result } = await call("check_calidda_credit", {
        dni: "1234 5678",
      });

      expect(result).toEqual({ status: "eligible", credit_line: "S/ 3500.00" });
      expect(execute).toHaveBeenCalledWith("12345678", {
        tenantId: ctx.tenantId,
        channelAccountId: ctx.channelAccountId,
        phoneNumber: PHONE,
      });
    });

    it("tells the model when the customer does not qualify or Cálidda is down", async () => {
      execute.mockResolvedValueOnce(Ok({ status: "not_eligible" }) as never);
      expect(
        (await call("check_calidda_credit", { dni: "12345678" })).result,
      ).toEqual({ status: "not_eligible" });

      execute.mockResolvedValueOnce(Ok({ status: "system_outage" }) as never);
      expect(
        (await call("check_calidda_credit", { dni: "12345678" })).result,
      ).toEqual(expect.objectContaining({ status: "unavailable" }));
    });

    it("refuses a DNI that is not 8 digits without checking", async () => {
      expect(
        (await call("check_calidda_credit", { dni: "1234567" })).result,
      ).toEqual({ error: "dni must be 8 digits" });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it("hand_off asks the turn to pass the chat to staff", async () => {
    expect(await call("hand_off", { reason: "wants a refund" })).toEqual({
      result: { handed_off: true },
      effects: [{ kind: "hand_off", reason: "wants a refund" }],
    });
  });

  it("see nothing of another business", async () => {
    const other = await createTenantFixture("assistant-tools-other");
    const there = {
      tenantId: other.tenantId,
      channelAccountId: other.channelAccountId,
    };

    expect(
      (await call("search_products", { query: null }, there)).result,
    ).toEqual({ products: [] });
    expect(
      (await call("get_product", { product_id: polo.product_id }, there))
        .result,
    ).toEqual({
      error: "product not found",
    });
    expect(
      (
        await call(
          "quote",
          { lines: [{ variant_id: polo.id, quantity: 1 }], zone_id: null },
          there,
        )
      ).result,
    ).toEqual({ error: `variant ${polo.id} is not for sale` });
  });
});
