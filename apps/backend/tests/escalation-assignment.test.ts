/**
 * A conversation the assistant hands off goes to an agent, and the agent hears
 * about it once. Each test runs the real turn; the only fakes are the network
 * and the model, which asks for `hand_off`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationRef, DomainEvent } from "@vendeya/types";

import { getOne, run } from "./helpers/db.ts";
import { answerMessage } from "../src/conversation/handler/index.ts";
import { checkAndReassignTimeouts } from "../src/domains/conversations/assignment.ts";
import { eventBus } from "../src/shared/events/index.ts";
import { type FakeModel, fakeModel, withOpenAiKey } from "./helpers/model.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  simulatorRef,
  type TenantFixture,
} from "./helpers/tenancy.ts";

const CUSTOMER = "51900888001";
const REASON = "customer_asked_for_a_person";
const ASK = "quiero hablar con una persona";

describe("handing a conversation off", () => {
  let tenant: TenantFixture;
  let alerts: Array<{ event: DomainEvent; assignedAtEmit: string | null }>;
  let assignments: DomainEvent[];
  let originalFetch: typeof globalThis.fetch;
  let model: FakeModel;

  const ref = () => tenant.ref(CUSTOMER);

  async function conversation() {
    const row = (await getOne(
      `SELECT assigned_agent, assignment_notified_at, status, handover_reason
         FROM conversations WHERE tenant_id = ? AND phone_number = ?`,
      [tenant.tenantId, CUSTOMER],
    )) as {
      assigned_agent: string | null;
      assignment_notified_at: number | null;
      status: string;
      handover_reason: string | null;
    };
    return {
      assignedAgent: row.assigned_agent,
      notifiedAt: row.assignment_notified_at,
      status: row.status,
      handoverReason: row.handover_reason,
    };
  }

  async function agentWithPhone(phone: string): Promise<string> {
    const { userId } = await createMember(tenant, "sales_agent");
    await run("UPDATE users SET phone_number = ? WHERE id = ?", [
      phone,
      userId,
    ]);
    return userId;
  }

  async function writes(target: ConversationRef, text: string) {
    await answerMessage({
      ref: target,
      content: text,
      timestamp: Date.now() - 11 * 60 * 1000,
      messageId: `wamid-${crypto.randomUUID()}`,
    });
  }

  /** The customer asks for a person and the model hands the chat off. */
  async function asksForAPerson(target = ref()): Promise<void> {
    model.calls({ name: "hand_off", arguments: { reason: REASON } });
    model.says("Te paso con una persona del equipo.");
    await writes(target, ASK);
  }

  const onAlert = async (event: DomainEvent) => {
    if (event.tenantId !== tenant.tenantId) return;
    alerts.push({
      event,
      assignedAtEmit: (await conversation()).assignedAgent,
    });
  };
  const onAssigned = (event: DomainEvent) => {
    if (event.tenantId === tenant.tenantId) assignments.push(event);
  };

  beforeEach(async () => {
    tenant = await createTenantFixture("escalation-assignment");
    await insertConversation(ref());
    await withOpenAiKey(tenant.tenantId);
    alerts = [];
    assignments = [];
    eventBus.on("escalation_triggered", onAlert);
    eventBus.on("agent_assigned", onAssigned);
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}")) as unknown as typeof fetch;
    model = fakeModel();
  });

  afterEach(async () => {
    eventBus.off("escalation_triggered", onAlert);
    eventBus.off("agent_assigned", onAssigned);
    model.restore();
    globalThis.fetch = originalFetch;
  });

  it("assigns an available agent and silences the assistant for them", async () => {
    const agent = await agentWithPhone("51911111111");

    await asksForAPerson();

    expect(await conversation()).toMatchObject({
      assignedAgent: agent,
      status: "human_takeover",
      handoverReason: REASON,
    });
    expect((await conversation()).notifiedAt).toBeGreaterThan(0);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      payload: { agentId: agent, agentPhone: "51911111111" },
    });
  });

  it("assigns before it alerts, so the alert reaches the agent", async () => {
    const agent = await agentWithPhone("51911111111");

    await asksForAPerson();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.assignedAtEmit).toBe(agent);
    expect(alerts[0]!.event.payload).toMatchObject({
      reason: REASON,
      context: { message: ASK },
    });
  });

  it("leaves the conversation to the sales group when nobody is available", async () => {
    const agent = await agentWithPhone("51911111111");
    await run(
      "UPDATE tenant_memberships SET is_available = 0 WHERE user_id = ?",
      [agent],
    );

    await asksForAPerson();

    expect(await conversation()).toMatchObject({
      assignedAgent: null,
      notifiedAt: null,
      status: "human_takeover",
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.assignedAtEmit).toBeNull();
    expect(assignments).toEqual([]);
  });

  describe("when the customer keeps writing", () => {
    it("alerts and assigns once, keeps the agent, and asks the model nothing", async () => {
      const agents = [
        await agentWithPhone("51911111111"),
        await agentWithPhone("51922222222"),
      ];
      await asksForAPerson();
      const afterHandOff = await conversation();
      expect(agents).toContain(afterHandOff.assignedAgent!);
      const calls = model.requests.length;

      await writes(ref(), "hola?");
      await writes(ref(), "¿alguien me atiende?");

      expect(alerts).toHaveLength(1);
      expect(assignments).toHaveLength(1);
      expect(model.requests).toHaveLength(calls);
      expect(await conversation()).toEqual(afterHandOff);
    });
  });

  describe("the agent does not take the conversation over", () => {
    it("is handed to the next agent by the timer, still held", async () => {
      const first = await agentWithPhone("51911111111");
      const second = await agentWithPhone("51922222222");
      await asksForAPerson();
      expect([first, second]).toContain((await conversation()).assignedAgent!);
      await run(
        "UPDATE conversations SET assignment_notified_at = ? WHERE tenant_id = ? AND phone_number = ?",
        [Date.now() - 10 * 60 * 1000, tenant.tenantId, CUSTOMER],
      );

      await checkAndReassignTimeouts();

      const after = await conversation();
      expect(after.assignedAgent).not.toBeNull();
      expect(after).toMatchObject({
        status: "human_takeover",
        handoverReason: REASON,
      });
      expect(after.notifiedAt).toBeGreaterThan(Date.now() - 60 * 1000);
      expect(assignments).toHaveLength(2);
    });
  });

  it("reaches nobody from a simulation", async () => {
    await agentWithPhone("51911111111");
    const simulated = await simulatorRef(tenant.tenantId, "51900000001");
    await insertConversation(simulated, { isSimulation: true });

    await asksForAPerson(simulated);

    const row = (await getOne(
      `SELECT assigned_agent, status FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [simulated.tenantId, simulated.channelAccountId, simulated.phoneNumber],
    )) as { assigned_agent: string | null; status: string };
    expect(row.status).toBe("human_takeover");
    expect(row.assigned_agent).toBeNull();
    expect(alerts).toHaveLength(0);
    expect(assignments).toHaveLength(0);
  });
});
