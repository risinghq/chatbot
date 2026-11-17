/**
 * A reply the bot could not send is kept instead of lost. The turn's callers
 * ask for that with `retry`; an agent's manual reply does not, because the
 * agent is looking at the error. The only fake is the network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAll, run } from "../src/db/index.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  type TenantFixture,
  setChannelStatus,
} from "./helpers/tenancy.ts";

import type { ConversationRef } from "@vendeya/types";

import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import { WhatsAppService } from "../src/adapters/whatsapp/index.ts";
import type { OutboxRow } from "../src/conversation/outbox.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { sendManualMessage } from "../src/domains/conversations/write.ts";

const CUSTOMER = "51900777001";

describe("a send the turn asked to keep", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let agent: string;
  let originalFetch: typeof globalThis.fetch;
  let requests: number;
  let answer: () => Response;

  const accepted = () =>
    new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), {
      headers: { "Content-Type": "application/json" },
    });
  /** A 502 with an HTML body: the adapter classifies it `transient`. */
  const unreachable = () =>
    new Response("<html>Bad gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    });
  /** Meta's re-engagement error: the adapter classifies it `permanent`. */
  const refused = () =>
    new Response(JSON.stringify({ error: { code: 131047 } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });

  async function outboxRows(): Promise<OutboxRow[]> {
    return (await getAll(
      `SELECT * FROM outbox
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?
         ORDER BY id`,
      [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
    )) as OutboxRow[];
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("outbox-service");
    // A number that genuinely sends, so the adapter reaches the fake network.
    await run("DELETE FROM channel_accounts WHERE id = ?", [
      tenant.channelAccountId,
    ]);
    const account = await ChannelAccountService.create({
      tenantId: tenant.tenantId,
      phoneNumberId: tenant.phoneNumberId,
      accessToken: "EAAG-a-real-looking-token",
    });
    tenant.channelAccountId = account.id;
    ref = {
      tenantId: tenant.tenantId,
      channelAccountId: account.id,
      phoneNumber: CUSTOMER,
    };
    await insertConversation(ref);
    agent = (await createMember(tenant, "sales_agent")).userId;

    requests = 0;
    answer = accepted;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      requests++;
      return answer();
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await run("DELETE FROM audit_log WHERE user_id = ?", [agent]);
  });

  it("queues a text WhatsApp could not take, and marks its message queued", async () => {
    answer = unreachable;

    const result = await WhatsAppService.sendMessage(ref, "hola", {
      retry: true,
    });

    expect(result).toMatchObject({
      ok: false,
      kind: "transient",
      queued: true,
    });
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "text",
      content: "hola",
      status: "pending",
      attempts: 1,
      ambiguous_attempts: 0,
      last_kind: "transient",
      last_reason: "http_502",
      handed_off_at: null,
    });
    expect(rows[0]!.next_attempt_at).toBe(rows[0]!.created_at + 5000);

    const history = await MessageStore.getHistory(ref);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: "queued", content: "hola" });
    expect(history[0]!.id).toBe(rows[0]!.message_id);
  });

  it("queues an image with its caption, and leaves the product on the message row", async () => {
    answer = unreachable;

    const result = await WhatsAppService.sendImage(
      ref,
      "images/img-1.jpg",
      "Cocina 4 hornillas",
      "bundle-1",
      { retry: true },
    );

    expect(result).toMatchObject({ queued: true });
    expect((await outboxRows())[0]).toMatchObject({
      type: "image",
      content: "images/img-1.jpg",
      caption: "Cocina 4 hornillas",
      status: "pending",
    });
    expect((await MessageStore.getHistory(ref))[0]).toMatchObject({
      type: "image",
      status: "queued",
      product_id: "bundle-1",
    });
  });

  it("keeps a permanently refused text as a failed row, and does not queue it", async () => {
    answer = refused;

    const result = await WhatsAppService.sendMessage(ref, "hola", {
      retry: true,
    });

    expect(result).toMatchObject({ ok: false, kind: "permanent" });
    expect(result.queued).toBeUndefined();
    expect((await outboxRows())[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      last_kind: "permanent",
      last_reason: "http_400:131047",
      handed_off_at: null,
    });
    expect((await MessageStore.getHistory(ref))[0]).toMatchObject({
      status: "failed",
    });
  });

  it("writes no row and no second message for an accepted send", async () => {
    const result = await WhatsAppService.sendMessage(ref, "hola", {
      retry: true,
    });

    expect(result).toEqual({ ok: true, messageId: "wamid.OK" });
    expect(await outboxRows()).toEqual([]);
    const history = await MessageStore.getHistory(ref);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "sent",
      whatsapp_message_id: "wamid.OK",
    });
  });

  it("queues behind a reply already waiting, without asking WhatsApp", async () => {
    answer = unreachable;
    await WhatsAppService.sendMessage(ref, "primero", { retry: true });
    const requestsAfterFirst = requests;
    answer = accepted;

    const result = await WhatsAppService.sendMessage(ref, "segundo", {
      retry: true,
    });

    expect(requests).toBe(requestsAfterFirst);
    expect(result).toMatchObject({ ok: false, queued: true });
    const rows = await outboxRows();
    expect(rows.map((row) => row.content)).toEqual(["primero", "segundo"]);
    expect(rows[1]).toMatchObject({
      status: "pending",
      attempts: 0,
      ambiguous_attempts: 0,
      last_kind: null,
      last_reason: null,
    });
    expect(rows[1]!.next_attempt_at).toBe(rows[1]!.created_at);
    expect(rows[1]!.id).toBeGreaterThan(rows[0]!.id);
  });

  it("queues behind a reply already waiting even when it is being sent", async () => {
    answer = unreachable;
    await WhatsAppService.sendMessage(ref, "primero", { retry: true });
    await run("UPDATE outbox SET status = 'sending' WHERE tenant_id = ?", [
      ref.tenantId,
    ]);
    const requestsAfterFirst = requests;
    answer = accepted;

    await WhatsAppService.sendMessage(ref, "segundo", { retry: true });

    expect(requests).toBe(requestsAfterFirst);
    expect((await outboxRows()).map((row) => row.status)).toEqual([
      "sending",
      "pending",
    ]);
  });

  it("queues nothing for a conversation of another number", async () => {
    answer = unreachable;
    await WhatsAppService.sendMessage(ref, "primero", { retry: true });

    const other = { ...ref, phoneNumber: "51900777002" };
    await insertConversation(other);
    answer = accepted;

    const result = await WhatsAppService.sendMessage(other, "hola", {
      retry: true,
    });

    expect(result).toEqual({ ok: true, messageId: "wamid.OK" });
    expect(await outboxRows()).toHaveLength(1);
  });

  it("keeps nothing when the caller did not ask for it", async () => {
    answer = unreachable;

    const result = await WhatsAppService.sendMessage(ref, "hola");

    expect(result).toMatchObject({ ok: false, kind: "transient" });
    expect(result.queued).toBeUndefined();
    expect(await outboxRows()).toEqual([]);
    expect((await MessageStore.getHistory(ref))[0]).toMatchObject({
      status: "failed",
    });
  });

  it("keeps nothing for an agent's manual reply", async () => {
    answer = unreachable;

    const result = await sendManualMessage(ref, "Hola, soy Ana", agent);

    expect(result.success).toBe(false);
    expect(await outboxRows()).toEqual([]);
    expect((await MessageStore.getHistory(ref))[0]).toMatchObject({
      status: "failed",
    });
  });

  it("still throws for a number switched off, and queues nothing", async () => {
    await setChannelStatus(ref.channelAccountId, "disabled");

    await expect(
      WhatsAppService.sendMessage(ref, "hola", { retry: true }),
    ).rejects.toThrow("is disabled, not active");
    expect(requests).toBe(0);
    expect(await outboxRows()).toEqual([]);
  });
});
