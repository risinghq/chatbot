/**
 * What the person holding a conversation hears when the customer keeps
 * writing. Each test sends real inbound messages through `answerMessage` and
 * reads what reaches the network: staff alerts, read receipts and typing
 * indicators. The only fakes are the network and the model, which hands the
 * conversation off when the customer asks for a person.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ConversationRef } from "@vendeya/types";

import { getOne, run } from "../src/db/index.ts";
import { answerMessage } from "../src/conversation/handler/index.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import {
  sendManualMessage,
  takeoverConversation,
} from "../src/domains/conversations/write.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import conversationRoutes from "../src/routes/conversations.ts";
import { TenantSettings } from "../src/domains/settings/system.ts";
import { type FakeModel, fakeModel, withOpenAiKey } from "./helpers/model.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  TEST_APP_SECRET,
  type TenantFixture,
} from "./helpers/tenancy.ts";

const CUSTOMER = "51900777001";
const AGENT_PHONE = "51911000001";
const SALES_GROUP = "120363000000000001@g.us";

type StaffMessage = { to: string; body: string };
type ReadReceipt = { messageId: string; typing: boolean };

describe("writing to a conversation a person holds", () => {
  let tenant: TenantFixture;
  let ref: ConversationRef;
  let agent: string;
  let originalFetch: typeof globalThis.fetch;
  let staffMessages: StaffMessage[];
  let receipts: ReadReceipt[];
  let staffSendsFail: boolean;
  let model: FakeModel;

  async function conversationFetch(
    _url: unknown,
    init?: RequestInit,
  ): Promise<Response> {
    const body = JSON.parse(String(init?.body));
    if (body.status === "read") {
      receipts.push({
        messageId: body.message_id,
        typing: "typing_indicator" in body,
      });
      return new Response("{}");
    }
    if (staffSendsFail && body.to === AGENT_PHONE) {
      return new Response(JSON.stringify({ error: { message: "refused" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    staffMessages.push({ to: body.to, body: body.text.body });
    return new Response(JSON.stringify({ messages: [{ id: "wamid-ok" }] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async function customerWrites(text: string): Promise<string> {
    const messageId = `wamid-${crypto.randomUUID()}`;
    await answerMessage({
      ref,
      content: text,
      timestamp: Date.now() - 11 * 60 * 1000,
      messageId,
    });
    return messageId;
  }

  /** The customer asks for a person and the model hands the chat off. */
  async function asksForAPerson(): Promise<void> {
    model.calls({
      name: "hand_off",
      arguments: { reason: "asked_for_a_person" },
    });
    model.says("Te paso con una persona del equipo.");
    await customerWrites("quiero hablar con una persona");
  }

  const sentTo = (to: string, containing: string) =>
    staffMessages.filter((m) => m.to === to && m.body.includes(containing));

  const agentMessageAlerts = () => sentTo(AGENT_PHONE, "escribió");
  const agentEscalationAlerts = () => sentTo(AGENT_PHONE, "requiere atención");

  async function giveAgentAPhone() {
    await run("UPDATE users SET phone_number = ? WHERE id = ?", [
      AGENT_PHONE,
      agent,
    ]);
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("held-alerts");
    // A number that genuinely sends, so the adapter reaches the fake network.
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
    await insertConversation(ref);
    await withOpenAiKey(tenant.tenantId);
    agent = (await createMember(tenant, "sales_agent")).userId;
    await TenantSettings.set(
      tenant.tenantId,
      "whatsapp_group_sales",
      SALES_GROUP,
    );

    staffMessages = [];
    receipts = [];
    staffSendsFail = false;

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
      conversationFetch(url, init)) as unknown as typeof fetch;
    model = fakeModel();
  });

  afterEach(async () => {
    model.restore();
    globalThis.fetch = originalFetch;
    await run("DELETE FROM audit_log WHERE user_id = ?", [agent]);
  });

  describe("after the bot escalated to an assigned agent", () => {
    beforeEach(async () => giveAgentAPhone());

    it("alerts the agent once, however long the customer keeps writing", async () => {
      await asksForAPerson();
      expect(agentEscalationAlerts()).toHaveLength(1);

      await customerWrites("hola?");
      await customerWrites("¿alguien me atiende?");

      expect(agentEscalationAlerts()).toHaveLength(1);
      expect(agentMessageAlerts()).toEqual([]);
    });

    it("alerts about the next message when the escalation alert did not go out", async () => {
      staffSendsFail = true;
      await asksForAPerson();
      expect(agentEscalationAlerts()).toEqual([]);

      staffSendsFail = false;
      await customerWrites("¿alguien me atiende?");
      await customerWrites("¿hola?");

      expect(agentMessageAlerts()).toHaveLength(1);
    });

    it("alerts the next agent about a message after the first one declined", async () => {
      const other = (await createMember(tenant, "sales_agent")).userId;
      const otherPhone = "51911000002";
      await run("UPDATE users SET phone_number = ? WHERE id = ?", [
        otherPhone,
        other,
      ]);

      await asksForAPerson();
      const holder = (await getOne(
        "SELECT assigned_agent FROM conversations WHERE tenant_id = ? AND phone_number = ?",
        [tenant.tenantId, CUSTOMER],
      )) as { assigned_agent: string };
      const heir = holder.assigned_agent === agent ? other : agent;
      const heirPhone = heir === agent ? AGENT_PHONE : otherPhone;

      const token = generateSessionToken();
      await createSession(token, holder.assigned_agent, tenant.tenantId);
      const app = new Hono();
      app.use("/api/*", requireAuth);
      app.route("/api/conversations", conversationRoutes);
      const declined = await app.request(
        `/api/conversations/${CUSTOMER}/decline-assignment?channel=${tenant.channelAccountId}`,
        { method: "POST", headers: { Cookie: `session=${token}` } },
      );
      expect(declined.status).toBe(200);
      staffMessages.length = 0;

      await customerWrites("¿alguien me atiende?");
      await customerWrites("¿hola?");

      expect(sentTo(heirPhone, "escribió")).toHaveLength(1);
      await run("DELETE FROM audit_log WHERE user_id = ?", [
        holder.assigned_agent,
      ]);
    });

    it("alerts again about a message once the agent has answered", async () => {
      await asksForAPerson();
      await sendManualMessage(ref, "Hola Ana, te atiendo", agent);
      staffMessages.length = 0;

      await customerWrites("gracias, ¿y el precio?");
      await customerWrites("¿sigues ahí?");

      expect(agentMessageAlerts()).toHaveLength(1);
      expect(agentMessageAlerts()[0]!.body).toContain(
        `/dashboard/conversations/${CUSTOMER}?channel=${tenant.channelAccountId}`,
      );
      expect(staffMessages.filter((m) => m.to === SALES_GROUP)).toEqual([]);
    });
  });

  describe("after an agent took the conversation over", () => {
    beforeEach(async () => {
      await giveAgentAPhone();
      await takeoverConversation(ref, agent);
    });

    it("tells the agent about a message, then waits for their answer", async () => {
      await customerWrites("hola, sigo esperando");
      await customerWrites("¿me escuchan?");
      expect(agentMessageAlerts()).toHaveLength(1);

      await sendManualMessage(ref, "Ya te atiendo", agent);
      await customerWrites("perfecto");
      await customerWrites("gracias");

      expect(agentMessageAlerts()).toHaveLength(2);
    });

    it("alerts again after a message alert that did not go out", async () => {
      staffSendsFail = true;
      await customerWrites("hola, sigo esperando");
      expect(agentMessageAlerts()).toEqual([]);

      staffSendsFail = false;
      await customerWrites("¿me escuchan?");
      await customerWrites("¿hola?");

      expect(agentMessageAlerts()).toHaveLength(1);
    });

    it("sends the customer a read receipt but no typing indicator", async () => {
      const messageId = await customerWrites("hola");

      expect(receipts).toEqual([{ messageId, typing: false }]);
    });
  });

  describe("while nobody is assigned", () => {
    it("leaves the sales group with the escalation alert alone", async () => {
      await asksForAPerson();
      await customerWrites("hola?");
      await customerWrites("¿alguien me atiende?");

      expect(sentTo(SALES_GROUP, "requiere atención")).toHaveLength(1);
      expect(staffMessages.filter((m) => m.body.includes("escribió"))).toEqual(
        [],
      );
    });
  });

  describe("while the bot owns the conversation", () => {
    it("shows the customer the typing indicator", async () => {
      const messageId = await customerWrites("hola");

      expect(receipts).toEqual([{ messageId, typing: true }]);
    });
  });
});
