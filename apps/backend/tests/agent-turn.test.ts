/**
 * A turn as the assistant runs it: the model reads the conversation, calls
 * tools, and answers. Each test delivers a signed webhook and lets the quiet
 * window pass. The only fakes are Graph and the model.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@vendeya/types";

import { db, getAll, getOne } from "../src/db/index.ts";
import { MAX_TOOL_CALLS } from "../src/domains/assistant/agent.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import { VariantService } from "../src/domains/catalog/variants.ts";
import { OPENAI_API_KEY_SETTING } from "../src/domains/settings/openai.ts";
import { TenantSecrets } from "../src/domains/settings/tenant-secrets.ts";
import { StockService } from "../src/domains/stock/index.ts";
import { eventBus } from "../src/shared/events/index.ts";
import { fakeGraph, withAccessToken } from "./helpers/graph.ts";
import { type FakeModel, fakeModel, withOpenAiKey } from "./helpers/model.ts";
import {
  createTenantFixture,
  setCaliddaLogin,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { customerWrites } from "./helpers/turn.ts";

const CUSTOMER = "51987000222";

let graph: ReturnType<typeof fakeGraph>;
let model: FakeModel;
let tenant: TenantFixture;
let events: DomainEvent[];

const record = (event: DomainEvent) => {
  if (event.tenantId === tenant.tenantId) events.push(event);
};

beforeEach(async () => {
  graph = fakeGraph();
  model = fakeModel();
  tenant = await createTenantFixture("agent-turn");
  await withAccessToken(tenant);
  await withOpenAiKey(tenant.tenantId);
  events = [];
  eventBus.on("order_created", record);
  eventBus.on("escalation_triggered", record);
});

afterEach(() => {
  eventBus.off("order_created", record);
  eventBus.off("escalation_triggered", record);
  model.restore();
  graph.restore();
});

async function stove(): Promise<{ productId: string; variantId: string }> {
  const product = await ProductService.create({
    tenantId: tenant.tenantId,
    name: "Cocina 4 hornillas",
    category: "cocinas",
  });
  const variant = await VariantService.create(tenant.tenantId, product.id, {
    name: null,
    sku: "COC-4",
    price_cents: 120_000,
    cost_cents: null,
    is_active: 1,
  });
  const location = await StockService.defaultLocation(tenant.tenantId);
  await StockService.record({
    tenantId: tenant.tenantId,
    variantId: variant.id,
    locationId: location!.id,
    kind: "receive",
    quantity: 5,
    createdBy: null,
  });
  return { productId: product.id, variantId: variant.id };
}

async function conversation() {
  return await getOne<{ status: string; handover_reason: string | null }>(
    `SELECT status, handover_reason FROM conversations
       WHERE tenant_id = ? AND phone_number = ?`,
    [tenant.tenantId, CUSTOMER],
  );
}

async function inbox(): Promise<string[]> {
  return (
    await getAll<{ status: string }>(
      "SELECT status FROM message_inbox WHERE tenant_id = ? ORDER BY id",
      [tenant.tenantId],
    )
  ).map((row) => row.status);
}

async function orders(): Promise<number> {
  return (
    await db
      .selectFrom("orders")
      .select("id")
      .where("tenant_id", "=", tenant.tenantId)
      .execute()
  ).length;
}

describe("a turn", () => {
  it("runs the tools the model calls and sends the answer that follows", async () => {
    await stove();
    model.calls({ name: "search_products", arguments: { query: "cocina" } });
    model.says("Tenemos la Cocina 4 hornillas a S/ 1,200.");

    await customerWrites(tenant, CUSTOMER, "¿tienen cocinas?");

    expect(model.requests).toHaveLength(2);
    const toolAnswer = model.requests[1]!.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolAnswer?.content).toContain("Cocina 4 hornillas");
    expect(graph.textsTo(CUSTOMER)).toEqual([
      "Tenemos la Cocina 4 hornillas a S/ 1,200.",
    ]);
    expect(await inbox()).toEqual(["processed"]);
  });

  it("records each model call in llm_calls", async () => {
    model.calls({ name: "search_products", arguments: { query: "cocina" } });
    model.says("No tenemos cocinas por ahora.");

    await customerWrites(tenant, CUSTOMER, "¿tienen cocinas?");

    const calls = await getAll<{
      operation: string;
      status: string;
      user_message: string;
      tokens_total: number;
    }>(
      `SELECT operation, status, user_message, tokens_total FROM llm_calls
         WHERE tenant_id = ? ORDER BY created_at, id`,
      [tenant.tenantId],
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toEqual({
        operation: "assistant_reply",
        status: "success",
        user_message: "¿tienen cocinas?",
        tokens_total: 120,
      });
    }
  });

  it("offers the Cálidda credit check only to a business with a Cálidda login", async () => {
    const offered = () => {
      const request = model.requests.at(-1)!;
      return {
        tool: request.tools.some(
          (t) => t.function.name === "check_calidda_credit",
        ),
        rule: request.messages[0]!.content!.includes("DNI"),
      };
    };

    await customerWrites(tenant, CUSTOMER, "hola");
    expect(offered()).toEqual({ tool: false, rule: false });

    await setCaliddaLogin(tenant.tenantId);
    await customerWrites(tenant, CUSTOMER, "quiero pagar con Cálidda");
    expect(offered()).toEqual({ tool: true, rule: true });
  });

  it("refuses a tool the business was not offered", async () => {
    model.calls({
      name: "check_calidda_credit",
      arguments: { dni: "12345678" },
    });
    model.says("No puedo revisar eso.");

    await customerWrites(tenant, CUSTOMER, "mi DNI es 12345678");

    const toolAnswer = model.requests[1]!.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolAnswer?.content).toBe(
      JSON.stringify({ error: "there is no tool named check_calidda_credit" }),
    );
  });

  it("reads the earlier messages of the conversation", async () => {
    model.says("¡Hola! ¿Qué buscas?");
    await customerWrites(tenant, CUSTOMER, "hola");
    await customerWrites(tenant, CUSTOMER, "una cocina");

    const second = model.requests[1]!.messages.map(({ role, content }) => ({
      role,
      content,
    }));
    expect(second.slice(1)).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "¡Hola! ¿Qué buscas?" },
      { role: "user", content: "una cocina" },
    ]);
  });

  it("tells the model which earlier message the customer replied to", async () => {
    model.says("Cocina 4 hornillas a S/ 1,200");
    await customerWrites(tenant, CUSTOMER, "¿tienen cocinas?");
    const offer = await getOne<{ whatsapp_message_id: string }>(
      `SELECT whatsapp_message_id FROM messages
         WHERE tenant_id = ? AND direction = 'outbound'`,
      [tenant.tenantId],
    );

    await customerWrites(tenant, CUSTOMER, "esa", {
      quoting: offer!.whatsapp_message_id,
    });

    expect(model.requests[1]!.messages.at(-1)).toEqual({
      role: "system",
      content:
        'The customer\'s latest message replies to this earlier message: "Cocina 4 hornillas a S/ 1,200"',
    });
  });

  it(`must answer in text after ${MAX_TOOL_CALLS} tool calls`, async () => {
    for (let i = 0; i < MAX_TOOL_CALLS; i++) {
      model.calls({ name: "search_products", arguments: { query: "x" } });
    }
    model.says("No encontré nada.");

    await customerWrites(tenant, CUSTOMER, "busca algo");

    expect(model.requests.map((request) => request.tool_choice)).toEqual([
      ...Array(MAX_TOOL_CALLS).fill("auto"),
      "none",
    ]);
    expect(graph.textsTo(CUSTOMER)).toEqual(["No encontré nada."]);
  });
});

describe("a business without an OpenAI key", () => {
  it("hands each conversation to a person without calling the model", async () => {
    await TenantSecrets.clear(tenant.tenantId, OPENAI_API_KEY_SETTING);

    await customerWrites(tenant, CUSTOMER, "hola");

    expect(model.requests).toHaveLength(0);
    expect(graph.textsTo(CUSTOMER)).toEqual([]);
    expect(await conversation()).toEqual({
      status: "human_takeover",
      handover_reason: "no_openai_key",
    });
    expect(events.map((event) => event.type)).toEqual(["escalation_triggered"]);
    expect(await inbox()).toEqual(["processed"]);
  });
});

/**
 * A retry would run create_order again, so a model that fails after it hands
 * the conversation to staff at once, and the order is still announced.
 */
describe("a model that fails after the turn filed an order", () => {
  it("hands off at once and announces the order", async () => {
    const { variantId } = await stove();
    model.calls({
      name: "create_order",
      arguments: {
        customer_name: "Juan Pérez",
        document_type: "dni",
        document_number: "12345678",
        lines: [{ variant_id: variantId, quantity: 1 }],
        address: null,
        zone_id: null,
        payment_method_id: null,
        notes: null,
      },
    });
    model.fails();

    await customerWrites(tenant, CUSTOMER, "sí, confirmo");

    expect(await orders()).toBe(1);
    expect(await inbox()).toEqual(["processed"]);
    expect(graph.textsTo(CUSTOMER)).toEqual([]);
    expect(await conversation()).toEqual({
      status: "human_takeover",
      handover_reason: "assistant_unavailable",
    });
    expect(events.map((event) => event.type)).toEqual([
      "order_created",
      "escalation_triggered",
    ]);
  });
});
