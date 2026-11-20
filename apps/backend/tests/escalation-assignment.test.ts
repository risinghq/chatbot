/**
 * A conversation that escalates is handed to an agent, and the agent hears
 * about it once. Each test runs the real bot turn; the only fake is the network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationPhase } from "@vendeya/core";
import type { DomainEvent } from "@vendeya/types";

import { getOne, run } from "../src/db/index.ts";
import { answerMessage } from "../src/conversation/handler/index.ts";
import { checkAndReassignTimeouts } from "../src/domains/conversations/assignment.ts";
import { eventBus } from "../src/shared/events/index.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  simulatorRef,
  type TenantFixture,
} from "./helpers/tenancy.ts";

const CUSTOMER = "51900888001";

const SECOND_OBJECTION: ConversationPhase = {
  phase: "handling_objection",
  segment: "fnb",
  credit: 3000,
  name: "Ana",
  objectionCount: 2,
};

describe("escalating a conversation", () => {
  let tenant: TenantFixture;
  let alerts: Array<{ event: DomainEvent; assignedAtEmit: string | null }>;
  let assignments: DomainEvent[];
  let originalFetch: typeof globalThis.fetch;

  const ref = () => tenant.ref(CUSTOMER);

  async function conversation() {
    const row = (await getOne(
      `SELECT assigned_agent, assignment_notified_at, status, handover_reason, context_data
         FROM conversations WHERE tenant_id = ? AND phone_number = ?`,
      [tenant.tenantId, CUSTOMER],
    )) as {
      assigned_agent: string | null;
      assignment_notified_at: number | null;
      status: string;
      handover_reason: string | null;
      context_data: string;
    };
    return {
      assignedAgent: row.assigned_agent,
      notifiedAt: row.assignment_notified_at,
      status: row.status,
      handoverReason: row.handover_reason,
      phase: JSON.parse(row.context_data).phase as ConversationPhase,
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

  async function customerWrites(text: string): Promise<void> {
    await answerMessage({
      ref: ref(),
      content: text,
      timestamp: Date.now() - 11 * 60 * 1000,
      messageId: `wamid-${crypto.randomUUID()}`,
    });
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
    await insertConversation(ref(), {
      contextData: {
        phase: SECOND_OBJECTION,
        metadata: { createdAt: Date.now(), lastActivityAt: Date.now() },
      },
    });
    alerts = [];
    assignments = [];
    eventBus.on("escalation_triggered", onAlert);
    eventBus.on("agent_assigned", onAssigned);
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}")) as unknown as typeof fetch;
  });

  afterEach(async () => {
    eventBus.off("escalation_triggered", onAlert);
    eventBus.off("agent_assigned", onAssigned);
    globalThis.fetch = originalFetch;
  });

  it("assigns an available agent and silences the bot for them", async () => {
    const agent = await agentWithPhone("51911111111");

    await customerWrites("no");

    expect(await conversation()).toMatchObject({
      assignedAgent: agent,
      status: "human_takeover",
      handoverReason: "multiple_objections",
      phase: { phase: "escalated", reason: "multiple_objections" },
    });
    expect((await conversation()).notifiedAt).toBeGreaterThan(0);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      payload: { agentId: agent, agentPhone: "51911111111" },
    });
  });

  it("assigns before it alerts, so the alert reaches the agent", async () => {
    const agent = await agentWithPhone("51911111111");

    await customerWrites("no");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.assignedAtEmit).toBe(agent);
  });

  it("leaves the conversation to the sales group when nobody is available", async () => {
    const agent = await agentWithPhone("51911111111");
    await run(
      "UPDATE tenant_memberships SET is_available = 0 WHERE user_id = ?",
      [agent],
    );

    await customerWrites("no");

    expect(await conversation()).toMatchObject({
      assignedAgent: null,
      notifiedAt: null,
      status: "human_takeover",
      phase: { phase: "escalated" },
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.assignedAtEmit).toBeNull();
    expect(assignments).toEqual([]);
  });

  describe("when the customer keeps writing", () => {
    it("alerts and assigns once, and keeps the agent and the time", async () => {
      const agents = [
        await agentWithPhone("51911111111"),
        await agentWithPhone("51922222222"),
      ];
      await customerWrites("no");
      const afterEscalation = await conversation();
      expect(agents).toContain(afterEscalation.assignedAgent!);

      await customerWrites("hola?");
      await customerWrites("¿alguien me atiende?");

      expect(alerts).toHaveLength(1);
      expect(assignments).toHaveLength(1);
      expect(await conversation()).toEqual(afterEscalation);
    });
  });

  describe("the agent does not take the conversation over", () => {
    it("is handed to the next agent by the timer, still escalated", async () => {
      const first = await agentWithPhone("51911111111");
      const second = await agentWithPhone("51922222222");
      await customerWrites("no");
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
        handoverReason: "multiple_objections",
        phase: { phase: "escalated" },
      });
      expect(after.notifiedAt).toBeGreaterThan(Date.now() - 60 * 1000);
      expect(assignments).toHaveLength(2);
    });
  });

  it("reaches nobody from a simulation", async () => {
    await agentWithPhone("51911111111");
    const simulated = await simulatorRef(tenant.tenantId, "51900000001");
    await insertConversation(simulated, {
      contextData: {
        phase: SECOND_OBJECTION,
        metadata: { createdAt: Date.now(), lastActivityAt: Date.now() },
      },
      isSimulation: true,
    });

    await answerMessage({
      ref: simulated,
      content: "no",
      timestamp: Date.now() - 11 * 60 * 1000,
      messageId: `wamid-${crypto.randomUUID()}`,
    });

    const row = (await getOne(
      `SELECT assigned_agent, context_data FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [simulated.tenantId, simulated.channelAccountId, simulated.phoneNumber],
    )) as { assigned_agent: string | null; context_data: string };
    expect(JSON.parse(row.context_data).phase).toMatchObject({
      phase: "escalated",
    });
    expect(row.assigned_agent).toBeNull();
    expect(alerts).toHaveLength(0);
    expect(assignments).toHaveLength(0);
  });
});
