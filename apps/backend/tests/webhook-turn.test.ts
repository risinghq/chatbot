import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAll, getOne } from "../src/db/index.ts";
import {
  fakeGraph,
  permanentFailure,
  withAccessToken,
} from "./helpers/graph.ts";
import { type FakeModel, fakeModel, withOpenAiKey } from "./helpers/model.ts";
import { createTenantFixture, type TenantFixture } from "./helpers/tenancy.ts";
import { backendFetch, deliver, quietWindowPasses } from "./helpers/turn.ts";
import { inboundText, signedWebhookRequest } from "./helpers/webhook.ts";

const CUSTOMER = "51987000111";

let graph: ReturnType<typeof fakeGraph>;
let model: FakeModel;
let tenantA: TenantFixture;
let tenantB: TenantFixture;

beforeEach(async () => {
  graph = fakeGraph();
  model = fakeModel();
  tenantA = await createTenantFixture("tenant-a");
  tenantB = await createTenantFixture("tenant-b");
  await withAccessToken(tenantA);
  await withAccessToken(tenantB);
  await withOpenAiKey(tenantA.tenantId);
  await withOpenAiKey(tenantB.tenantId);
});

afterEach(() => {
  model.restore();
  graph.restore();
});

function inboxOf(tenant: TenantFixture) {
  return getAll<{ message_text: string; status: string }>(
    "SELECT message_text, status FROM message_inbox WHERE tenant_id = ? ORDER BY id",
    [tenant.tenantId],
  );
}

describe("an inbound message", () => {
  it("is answered through the number it arrived on, with that tenant's token", async () => {
    const response = await deliver(tenantA.phoneNumberId, CUSTOMER, "hola");
    expect(response.status).toBe(200);
    expect(graph.sends).toHaveLength(0);

    expect(await quietWindowPasses(tenantA.ref(CUSTOMER))).toBe(true);

    expect(graph.replies().length).toBeGreaterThan(0);
    for (const send of graph.sends) {
      expect(send.phoneNumberId).toBe(tenantA.phoneNumberId);
      expect(send.token).toBe(`token-${tenantA.tenantId}`);
    }
    for (const send of graph.replies()) {
      expect(send.payload.to).toBe(CUSTOMER);
    }
    expect(await inboxOf(tenantA)).toEqual([
      { message_text: "hola", status: "processed" },
    ]);
  });

  it("for another tenant's number lands only in that tenant", async () => {
    await deliver(tenantB.phoneNumberId, CUSTOMER, "hola");
    await quietWindowPasses(tenantB.ref(CUSTOMER));

    expect(await inboxOf(tenantA)).toEqual([]);
    expect(
      await getOne("SELECT 1 FROM conversations WHERE tenant_id = ?", [
        tenantA.tenantId,
      ]),
    ).toBeUndefined();
    expect(await inboxOf(tenantB)).toEqual([
      { message_text: "hola", status: "processed" },
    ]);
    expect(new Set(graph.sends.map((send) => send.phoneNumberId))).toEqual(
      new Set([tenantB.phoneNumberId]),
    );
  });
});

describe("the quiet window", () => {
  /**
   * Meta's message ids carry no order, so the later message here has the id
   * that sorts first. The turn still answers, and marks read, the newest one.
   */
  it("joins two messages sent close together into one turn", async () => {
    const sentAt = Date.now() - 11 * 60 * 1000;
    for (const [id, text] of [
      ["wamid-zzz-first", "hola"],
      ["wamid-aaa-second", "quiero un celular"],
    ] as const) {
      await backendFetch(
        "/api/webhook",
        await signedWebhookRequest(
          inboundText(tenantA.phoneNumberId, CUSTOMER, text, { id, sentAt }),
        ),
      );
    }
    expect(graph.sends).toHaveLength(0);

    expect(await quietWindowPasses(tenantA.ref(CUSTOMER))).toBe(true);

    expect(graph.readReceipts()).toEqual(["wamid-aaa-second"]);

    expect(await inboxOf(tenantA)).toEqual([
      { message_text: "hola", status: "processed" },
      { message_text: "quiero un celular", status: "processed" },
    ]);
  });
});

describe("a reply Meta refuses for good", () => {
  it("hands the conversation to a person", async () => {
    graph.respondWith(permanentFailure);

    await deliver(tenantA.phoneNumberId, CUSTOMER, "hola");
    await quietWindowPasses(tenantA.ref(CUSTOMER));

    const conversation = await getOne<{
      status: string;
      handover_reason: string | null;
    }>(
      "SELECT status, handover_reason FROM conversations WHERE tenant_id = ? AND phone_number = ?",
      [tenantA.tenantId, CUSTOMER],
    );
    expect(conversation).toEqual({
      status: "human_takeover",
      handover_reason: "reply_undeliverable",
    });

    const outbox = await getAll<{ status: string }>(
      "SELECT status FROM outbox WHERE tenant_id = ?",
      [tenantA.tenantId],
    );
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox.every((row) => row.status !== "pending")).toBe(true);
  });
});
