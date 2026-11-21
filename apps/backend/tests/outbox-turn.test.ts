/**
 * A whole turn whose first reply WhatsApp would not take. The rest of the turn
 * queues behind it, the conversation still moves on, and the worker delivers
 * every reply in the order the bot produced them. Each test runs the real path
 * from a signed webhook, and the only fake is the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAll, run } from "../src/db/index.ts";
import {
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";
import { customerWrites, wakeAt } from "./helpers/turn.ts";

import type { ConversationRef } from "@vendeya/types";

import type { OutboxRow } from "../src/conversation/outbox.ts";
import { ProductImageService } from "../src/domains/catalog/images.ts";
import { ProductService } from "../src/domains/catalog/products.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { type FakeModel, fakeModel, withOpenAiKey } from "./helpers/model.ts";

const CUSTOMER = "51900666001";
const HOUR = 60 * 60 * 1000;

describe("a turn whose first reply could not be sent", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let originalFetch: typeof globalThis.fetch;
  /** What WhatsApp accepted, in order: a text body or an image link. */
  let delivered: string[];
  /** Sends refused so far, and how many to refuse before accepting. */
  let refused: number;
  let toRefuse: number;
  let model: FakeModel;

  async function rows(): Promise<OutboxRow[]> {
    return (await getAll(
      `SELECT * FROM outbox
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
         ORDER BY id`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    )) as OutboxRow[];
  }

  async function outboundStatuses(): Promise<string[]> {
    return (
      (await getAll(
        `SELECT status FROM messages
           WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
             AND direction = 'outbound'
           ORDER BY created_at, ROWID`,
        [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
      )) as Array<{
        status: string;
      }>
    ).map((row) => row.status);
  }

  async function inboxStatuses(): Promise<string[]> {
    return (
      (await getAll(
        "SELECT status FROM message_inbox WHERE channel_account_id = ? ORDER BY id",
        [tenant.channelAccountId],
      )) as Array<{ status: string }>
    ).map((row) => row.status);
  }

  async function goIdle(): Promise<void> {
    await run(
      `UPDATE conversations
       SET last_activity_at = ?
       WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [
        Date.now() - 4 * HOUR,
        ref.tenantId,
        ref.channelAccountId,
        ref.phoneNumber,
      ],
    );
  }

  /** Runs passes until the conversation owes nothing, at a clock the test moves. */
  async function drainOutbox(): Promise<void> {
    for (let pass = 0; pass < 10; pass++) {
      const waiting = (await rows()).filter(
        (row) => row.status === "pending" || row.status === "sending",
      );
      if (waiting.length === 0) return;
      await wakeAt(ref, waiting[0]!.next_attempt_at);
    }
    throw new Error("The outbox did not drain");
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("outbox-turn");
    // A number that genuinely sends, so a bot reply reaches the fake network.
    await run("DELETE FROM channel_accounts WHERE id = ?", [
      tenant.channelAccountId,
    ]);
    const account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: tenant.phoneNumberId,
      accessToken: "EAAG-a-real-looking-token",
      appSecret: TEST_APP_SECRET,
    });
    tenant.channelAccountId = account.id;
    ref = {
      tenantId: tenant.tenantId,
      channelAccountId: account.id,
      phoneNumber: CUSTOMER,
    };

    delivered = [];
    refused = 0;
    toRefuse = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.type !== "text" && body.type !== "image") {
        // A read receipt, which is not part of the reply.
        return new Response(JSON.stringify({ messages: [{ id: "wamid-r" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (refused < toRefuse) {
        refused++;
        return new Response("<html>Bad gateway</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      }
      delivered.push(
        body.type === "text"
          ? body.text.body
          : String(body.image.link).replace(/^.*\/media\//, ""),
      );
      return new Response(
        JSON.stringify({ messages: [{ id: `wamid-out-${delivered.length}` }] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;
    model = fakeModel();
    await withOpenAiKey(tenant.tenantId);
  });

  afterEach(async () => {
    vi.useRealTimers();
    model.restore();
    globalThis.fetch = originalFetch;
  });

  it("queues the whole turn behind the reply that failed, and delivers it in order", async () => {
    await insertConversation(ref);
    const product = await ProductService.create({
      tenantId: tenant.tenantId,
      name: "Cocina 4 hornillas",
      category: "cocinas",
      status: "active",
    });
    for (const imageId of ["img-front", "img-side"]) {
      await ProductImageService.add({
        tenantId: tenant.tenantId,
        productId: product.id,
        imageId,
        byteSize: 1000,
        createdBy: null,
      });
    }
    model.calls({
      name: "send_product_photos",
      arguments: { product_id: product.id },
    });
    model.says("Te envío las fotos de la cocina.");
    toRefuse = 1;

    await customerWrites(tenant, CUSTOMER, "quiero ver cocinas");

    // The reply and the two photos after it. Only the reply reached
    // WhatsApp, and the photos queued behind it without a request.
    const queued = await rows();
    expect(queued.map((row) => row.type)).toEqual(["text", "image", "image"]);
    expect(queued.map((row) => row.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(refused).toBe(1);
    expect(delivered).toEqual([]);
    expect(queued[0]).toMatchObject({ attempts: 1, last_kind: "transient" });
    expect(queued[1]).toMatchObject({ attempts: 0, last_kind: null });
    expect(queued[2]).toMatchObject({ attempts: 0, last_kind: null });
    expect(await outboundStatuses()).toEqual(["queued", "queued", "queued"]);

    // The turn finished: the customer's message is answered for.
    expect(await inboxStatuses()).toEqual(["processed"]);

    await drainOutbox();

    expect(delivered).toEqual([
      "Te envío las fotos de la cocina.",
      `${tenant.tenantId}/images/img-front.jpg`,
      `${tenant.tenantId}/images/img-side.jpg`,
    ]);
    expect((await rows()).map((row) => row.status)).toEqual([
      "sent",
      "sent",
      "sent",
    ]);
    expect(await outboundStatuses()).toEqual(["sent", "sent", "sent"]);
  });

  it("keeps the next turn's reply behind the one still owed", async () => {
    await insertConversation(ref);
    toRefuse = 1;

    await customerWrites(tenant, CUSTOMER, "hola");

    expect(await rows()).toHaveLength(1);
    expect(refused).toBe(1);

    // The customer comes back after the idle reset and is answered again.
    await goIdle();
    await customerWrites(tenant, CUSTOMER, "hola de nuevo");

    const queued = await rows();
    expect(queued).toHaveLength(2);
    expect(queued[1]).toMatchObject({ status: "pending", attempts: 0 });
    expect(delivered).toEqual([]);
    expect(await inboxStatuses()).toEqual(["processed", "processed"]);

    const order = queued.map((row) => row.content);

    await drainOutbox();

    expect(delivered).toEqual(order);
    expect((await rows()).map((row) => row.status)).toEqual(["sent", "sent"]);
  });
});
