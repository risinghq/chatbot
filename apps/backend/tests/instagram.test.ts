/**
 * An Instagram professional account: DMs reach the bot through the same
 * pipeline as WhatsApp, comments get a public and a private reply, and sends
 * respect Instagram's messaging window.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { newId } from "@vendeya/utils";

import { WhatsAppService } from "../src/adapters/whatsapp/index.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import adminRoutes from "../src/routes/admin.ts";
import { requireRole } from "../src/middleware/auth.ts";
import { getAll, getOne, run } from "./helpers/db.ts";
import { fakeGraph } from "./helpers/graph.ts";
import { type FakeModel, fakeModel, withOpenAiKey } from "./helpers/model.ts";
import {
  createMember,
  insertConversation,
  insertTenant,
  insertUser,
  TEST_APP_SECRET,
} from "./helpers/tenancy.ts";
import { backendFetch, quietWindowPasses } from "./helpers/turn.ts";
import { signWebhookBody } from "./helpers/webhook.ts";
import type { ConversationRef } from "@vendeya/types";

const CUSTOMER = "1789000111";
const DAY = 24 * 60 * 60 * 1000;

let graph: ReturnType<typeof fakeGraph>;
let model: FakeModel;
let tenantId: string;
let accountId: string;
let igId: string;

const refOf = (phoneNumber: string): ConversationRef => ({
  tenantId,
  channelAccountId: accountId,
  phoneNumber,
});

beforeEach(async () => {
  graph = fakeGraph();
  model = fakeModel();
  tenantId = await insertTenant("instagram");
  accountId = newId();
  igId = `ig-${crypto.randomUUID().slice(0, 8)}`;
  await ChannelAccountService.create({
    id: accountId,
    tenantId,
    channelType: "instagram",
    phoneNumberId: igId,
    accessToken: "ig-token",
    appSecret: TEST_APP_SECRET,
    status: "active",
  });
  await withOpenAiKey(tenantId);
});

afterEach(() => {
  model.restore();
  graph.restore();
});

async function post(body: unknown, secret = TEST_APP_SECRET) {
  const raw = JSON.stringify(body);
  return backendFetch("/api/webhook/instagram", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": await signWebhookBody(raw, secret),
    },
    body: raw,
  });
}

function dm(
  text: string,
  options: { from?: string; mid?: string; echo?: boolean } = {},
) {
  return {
    object: "instagram",
    entry: [
      {
        id: igId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: options.from ?? CUSTOMER },
            recipient: { id: igId },
            timestamp: Date.now() - 11 * 60 * 1000,
            message: {
              mid: options.mid ?? `mid-${crypto.randomUUID()}`,
              text,
              ...(options.echo ? { is_echo: true } : {}),
            },
          },
        ],
      },
    ],
  };
}

function comment(
  id: string,
  options: { from?: string; parentId?: string } = {},
) {
  return {
    object: "instagram",
    entry: [
      {
        id: igId,
        time: Date.now(),
        changes: [
          {
            field: "comments",
            value: {
              id,
              text: "precio?",
              from: { id: options.from ?? CUSTOMER, username: "cliente" },
              media: { id: "media-1" },
              ...(options.parentId ? { parent_id: options.parentId } : {}),
            },
          },
        ],
      },
    ],
  };
}

describe("an Instagram DM", () => {
  it("is answered in a DM through the account it arrived on", async () => {
    const response = await post(dm("hola"));
    expect(response.status).toBe(200);

    expect(await quietWindowPasses(refOf(CUSTOMER))).toBe(true);

    const replies = graph.replies();
    expect(replies.length).toBeGreaterThan(0);
    for (const send of replies) {
      expect(send.host).toBe("instagram");
      expect(send.path).toBe(`${igId}/messages`);
      expect(send.token).toBe("ig-token");
      expect(send.payload.recipient).toEqual({ id: CUSTOMER });
      expect(send.payload).not.toHaveProperty("tag");
    }
    expect(
      await getAll("SELECT direction FROM messages WHERE tenant_id = ?", [
        tenantId,
      ]),
    ).toContainEqual({ direction: "inbound" });
  });

  it("with a bad signature is refused", async () => {
    const response = await post(dm("hola"), "wrong-secret");
    expect(response.status).toBe(401);
    expect(
      await getOne("SELECT 1 FROM conversations WHERE tenant_id = ?", [
        tenantId,
      ]),
    ).toBeUndefined();
  });

  it("for an unknown account is refused", async () => {
    const body = dm("hola");
    body.entry[0]!.id = "ig-unknown";
    expect((await post(body)).status).toBe(401);
  });

  it("that echoes our own send is ignored", async () => {
    const response = await post(dm("hola", { echo: true }));
    expect(await response.json()).toEqual({
      results: [{ accountId: igId, status: "ignored" }],
    });
    expect(
      await getOne("SELECT 1 FROM conversations WHERE tenant_id = ?", [
        tenantId,
      ]),
    ).toBeUndefined();
  });

  it("redelivered by Meta is handled once", async () => {
    const body = dm("hola", { mid: "mid-once" });
    await post(body);
    await post(body);
    expect(
      await getAll(
        "SELECT 1 FROM messages WHERE tenant_id = ? AND direction = 'inbound'",
        [tenantId],
      ),
    ).toHaveLength(1);
  });
});

describe("an Instagram comment", () => {
  it("gets a public reply and a DM, and starts the conversation", async () => {
    const response = await post(comment("c-1"));
    expect(await response.json()).toEqual({
      results: [{ accountId: igId, status: "comment_claimed" }],
    });

    const [publicReply, privateReply] = graph.sends;
    expect(publicReply).toMatchObject({
      host: "instagram",
      path: "c-1/replies",
      payload: { message: expect.any(String) },
    });
    expect(privateReply).toMatchObject({
      path: `${igId}/messages`,
      payload: { recipient: { comment_id: "c-1" } },
    });
    expect(
      await getOne(
        "SELECT public_reply_status, private_reply_status FROM instagram_comments WHERE comment_id = ?",
        ["c-1"],
      ),
    ).toEqual({ public_reply_status: "sent", private_reply_status: "sent" });
    expect(
      await getAll(
        "SELECT direction FROM messages WHERE tenant_id = ? AND phone_number = ?",
        [tenantId, CUSTOMER],
      ),
    ).toEqual([{ direction: "outbound" }]);
  });

  it("redelivered by Meta is answered once", async () => {
    await post(comment("c-2"));
    const second = await post(comment("c-2"));
    expect(await second.json()).toEqual({
      results: [{ accountId: igId, status: "comment_duplicate" }],
    });
    expect(graph.sends).toHaveLength(2);
  });

  it("by the account itself, or inside a thread, gets no answer", async () => {
    await post(comment("c-own", { from: igId }));
    await post(comment("c-thread", { parentId: "c-1" }));
    expect(graph.sends).toHaveLength(0);
  });

  it("is recorded but not answered when replies are off", async () => {
    await run(
      "INSERT INTO tenant_settings (tenant_id, key, value, updated_at) VALUES (?, 'ig_comment_reply_enabled', '0', 0)",
      [tenantId],
    );
    await post(comment("c-off"));
    expect(graph.sends).toHaveLength(0);
    expect(
      await getOne(
        "SELECT public_reply_status FROM instagram_comments WHERE comment_id = ?",
        ["c-off"],
      ),
    ).toEqual({ public_reply_status: "skipped" });
  });

  it("whose public reply fails still gets its DM", async () => {
    graph.respondWith((send) =>
      send.path.endsWith("/replies")
        ? Response.json({ error: { code: 10 } }, { status: 400 })
        : Response.json({ message_id: "m-1" }),
    );
    await post(comment("c-fail"));
    expect(
      await getOne(
        "SELECT public_reply_status, private_reply_status FROM instagram_comments WHERE comment_id = ?",
        ["c-fail"],
      ),
    ).toEqual({ public_reply_status: "failed", private_reply_status: "sent" });
  });
});

describe("Instagram's messaging window", () => {
  async function lastInboundAgo(ms: number) {
    const ref = refOf(CUSTOMER);
    await insertConversation(ref);
    await run(
      `INSERT INTO messages (id, tenant_id, channel_account_id, phone_number, direction, type, content, status, created_at)
       VALUES (?, ?, ?, ?, 'inbound', 'text', 'hola', 'received', ?)`,
      [newId(), tenantId, accountId, CUSTOMER, Date.now() - ms],
    );
    return ref;
  }

  it("lets the bot answer within 24 hours", async () => {
    const ref = await lastInboundAgo(DAY - 60_000);
    const sent = await WhatsAppService.sendMessage(ref, "hola", {
      retry: true,
    });
    expect(sent.ok).toBe(true);
    expect(graph.sends[0]!.payload).not.toHaveProperty("tag");
  });

  it("refuses the bot after 24 hours", async () => {
    const ref = await lastInboundAgo(DAY + 60_000);
    const sent = await WhatsAppService.sendMessage(ref, "hola", {
      retry: true,
    });
    expect(sent).toMatchObject({ ok: false, reason: "outside_window" });
    expect(graph.sends).toHaveLength(0);
  });

  it("lets a person reply up to 7 days, tagged HUMAN_AGENT", async () => {
    const ref = await lastInboundAgo(3 * DAY);
    const sent = await WhatsAppService.sendMessage(ref, "hola");
    expect(sent.ok).toBe(true);
    expect(graph.sends[0]!.payload).toMatchObject({
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
  });

  it("refuses a person after 7 days", async () => {
    const ref = await lastInboundAgo(8 * DAY);
    const sent = await WhatsAppService.sendMessage(ref, "hola");
    expect(sent).toMatchObject({ ok: false, reason: "outside_window" });
  });
});

describe("the comment reply settings", () => {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin", adminRoutes);
  app.onError(errorHandler);

  async function as(role: "admin" | "sales_agent") {
    const { userId } = await createMember({ tenantId }, role);
    const token = generateSessionToken();
    await createSession(token, userId, tenantId);
    return (method: string, body?: unknown) =>
      app.request("/api/admin/instagram/comments", {
        method,
        headers: {
          Cookie: `session=${token}`,
          "X-Tenant-Id": tenantId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  }

  it("start on and are saved by an admin", async () => {
    const call = await as("admin");
    expect(await (await call("GET")).json()).toMatchObject({ enabled: true });

    const saved = { enabled: false, public_text: "Gracias", private_text: "" };
    expect((await call("PUT", saved)).status).toBe(200);
    expect(await (await call("GET")).json()).toEqual(saved);
  });

  it("refuse an over-long text", async () => {
    const call = await as("admin");
    const response = await call("PUT", {
      enabled: true,
      public_text: "x".repeat(1001),
      private_text: "",
    });
    expect(response.status).toBe(400);
  });

  it("are not changed by a sales agent", async () => {
    const call = await as("sales_agent");
    expect((await call("GET")).status).toBe(403);
  });
});

describe("registering an Instagram account", () => {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin", adminRoutes);
  app.onError(errorHandler);

  it("is listed with the tenant's channels", async () => {
    const { userId } = await createMember({ tenantId }, "admin");
    const token = generateSessionToken();
    await createSession(token, userId, tenantId);
    const response = await app.request("/api/admin/channels", {
      headers: { Cookie: `session=${token}`, "X-Tenant-Id": tenantId },
    });
    expect(response.status).toBe(200);
    const { accounts } = (await response.json()) as {
      accounts: { channel_type: string; phone_number_id: string }[];
    };
    expect(accounts).toContainEqual(
      expect.objectContaining({
        channel_type: "instagram",
        phone_number_id: igId,
      }),
    );
  });

  async function operatorPost(body: unknown) {
    const userId = await insertUser({ isPlatformOperator: true });
    const token = generateSessionToken();
    await createSession(token, userId, tenantId);
    return app.request("/api/admin/channels", {
      method: "POST",
      headers: {
        Cookie: `session=${token}`,
        "X-Tenant-Id": tenantId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("gives the Instagram webhook URL", async () => {
    const response = await operatorPost({
      channelType: "instagram",
      phoneNumberId: "ig-new",
      accessToken: "t",
      appSecret: "s",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const account = (await response.json()) as { webhook_url: string };
    expect(account.webhook_url).toMatch(/\/api\/webhook\/instagram$/);
  });

  it("refuses an id the same channel already has", async () => {
    const response = await operatorPost({
      channelType: "instagram",
      phoneNumberId: igId,
    });
    expect(response.status).toBe(409);
  });

  it("refuses an unknown channel type", async () => {
    const response = await operatorPost({
      channelType: "tiktok",
      phoneNumberId: "x",
    });
    expect(response.status).toBe(400);
  });
});
