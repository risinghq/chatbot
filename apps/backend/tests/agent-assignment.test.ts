import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import { getOne, run } from "./helpers/db.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  insertUser,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import { whileLocked } from "./helpers/turn.ts";
import { checkAndReassignTimeouts } from "../src/domains/conversations/assignment.ts";
import conversationRoutes from "../src/routes/conversations.ts";
import adminUserRoutes from "../src/routes/admin/users.ts";
import tenantRoutes from "../src/routes/tenants.ts";

const CUSTOMER = "51900444001";

type Auth = { cookie: string; tenantId: string | null };

function buildApp() {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.route("/api/conversations", conversationRoutes);
  app.route("/api/tenants", tenantRoutes);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin/users", adminUserRoutes);
  app.onError(errorHandler);
  return app;
}

async function login(userId: string, tenantId: string | null): Promise<Auth> {
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);
  return { cookie: `session=${token}`, tenantId };
}

async function createOperator(): Promise<string> {
  return insertUser({ name: "Operator", isPlatformOperator: true });
}

describe("conversation assignment", () => {
  let app: ReturnType<typeof buildApp>;
  let tenant: TenantFixture;
  let admin: Auth;
  let operator: Auth;

  beforeEach(async () => {
    app = buildApp();
    tenant = await createTenantFixture("assignment");
    admin = await login(
      (await createMember(tenant, "admin")).userId,
      tenant.tenantId,
    );
    operator = await login(await createOperator(), null);
    await insertConversation(tenant.ref(CUSTOMER));
  });

  function request(
    method: string,
    path: string,
    auth: Auth,
    body?: unknown,
  ): Promise<Response> {
    return Promise.resolve(
      app.request(path, {
        method,
        headers: {
          Cookie: auth.cookie,
          ...(auth.tenantId ? { "X-Tenant-Id": auth.tenantId } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  const takeover = (auth: Auth) =>
    request("POST", `/api/conversations/${CUSTOMER}/takeover`, auth);

  async function assignedAgent(): Promise<string | null> {
    return (
      (await getOne(
        "SELECT assigned_agent FROM conversations WHERE tenant_id = ? AND phone_number = ?",
        [tenant.tenantId, CUSTOMER],
      )) as { assigned_agent: string | null }
    ).assigned_agent;
  }

  async function visibleTo(auth: Auth): Promise<boolean> {
    const response = await request("GET", "/api/conversations", auth);
    const rows = (await response.json()) as Array<{ phone_number: string }>;
    return rows.some((row) => row.phone_number === CUSTOMER);
  }

  async function newAgent() {
    const { userId } = await createMember(tenant, "sales_agent");
    return { userId, auth: await login(userId, tenant.tenantId) };
  }

  describe("takeover", () => {
    it("assigns the agent who takes over", async () => {
      const agent = await newAgent();

      const response = await takeover(agent.auth);

      expect(response.status).toBe(200);
      expect(await assignedAgent()).toBe(agent.userId);
    });

    it("turns a second taker away and keeps the first", async () => {
      const first = await newAgent();
      await takeover(first.auth);

      const response = await takeover(admin);

      expect(response.status).toBe(409);
      expect(await assignedAgent()).toBe(first.userId);
    });

    it("does not let another agent reach a conversation an agent holds", async () => {
      const first = await newAgent();
      const second = await newAgent();
      await takeover(first.auth);

      const response = await takeover(second.auth);

      expect(response.ok).toBe(false);
      expect(await assignedAgent()).toBe(first.userId);
    });

    it("lets the agent who holds the conversation repeat the takeover", async () => {
      const agent = await newAgent();
      await takeover(agent.auth);

      const response = await takeover(agent.auth);

      expect(response.status).toBe(200);
      expect(await assignedAgent()).toBe(agent.userId);
    });

    it("lets one of two simultaneous takers win", async () => {
      const first = await newAgent();
      const second = await newAgent();

      const [a, b] = await Promise.all([
        takeover(first.auth),
        takeover(second.auth),
      ]);

      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect(await assignedAgent()).toBe(a.ok ? first.userId : second.userId);
    });
  });

  describe("removing an agent", () => {
    it("clears their conversations so another agent can take them", async () => {
      const removed = await newAgent();
      await takeover(removed.auth);

      const response = await request(
        "DELETE",
        `/api/admin/users/${removed.userId}/membership`,
        admin,
      );
      expect(response.status).toBe(200);
      expect(await assignedAgent()).toBeNull();

      const next = await newAgent();
      expect((await takeover(next.auth)).status).toBe(200);
      expect(await assignedAgent()).toBe(next.userId);
    });

    it("does not hand the conversation back when the agent is added again", async () => {
      const removed = await newAgent();
      await takeover(removed.auth);
      await request(
        "DELETE",
        `/api/admin/users/${removed.userId}/membership`,
        admin,
      );
      const next = await newAgent();
      await takeover(next.auth);

      const added = await request(
        "POST",
        `/api/tenants/${tenant.tenantId}/members`,
        operator,
        { userId: removed.userId, role: "sales_agent" },
      );
      expect(added.status).toBe(201);

      expect(await assignedAgent()).toBe(next.userId);
      expect(
        await visibleTo(await login(removed.userId, tenant.tenantId)),
      ).toBe(false);
    });

    it("leaves the conversations of other agents alone", async () => {
      const removed = await newAgent();
      const kept = await newAgent();
      await takeover(kept.auth);

      await request(
        "DELETE",
        `/api/admin/users/${removed.userId}/membership`,
        admin,
      );

      expect(await assignedAgent()).toBe(kept.userId);
    });
  });

  describe("deactivating an agent", () => {
    const setStatus = (userId: string) =>
      request("PATCH", `/api/admin/users/${userId}/status`, admin);

    it("clears their conversations so another agent can take them", async () => {
      const agent = await newAgent();
      await takeover(agent.auth);

      const response = await setStatus(agent.userId);
      expect(response.status).toBe(200);
      expect(await assignedAgent()).toBeNull();

      const next = await newAgent();
      expect((await takeover(next.auth)).status).toBe(200);
      expect(await assignedAgent()).toBe(next.userId);
    });

    it("does not return them when the account is turned back on", async () => {
      const agent = await newAgent();
      await takeover(agent.auth);
      await setStatus(agent.userId);

      const response = await setStatus(agent.userId);

      expect(response.status).toBe(200);
      expect(await assignedAgent()).toBeNull();
    });

    it("leaves the conversations of other agents alone", async () => {
      const gone = await newAgent();
      const kept = await newAgent();
      await takeover(kept.auth);

      await setStatus(gone.userId);

      expect(await assignedAgent()).toBe(kept.userId);
    });
  });

  describe("releasing a conversation", () => {
    it("clears the agent so another agent can take it", async () => {
      const first = await newAgent();
      await takeover(first.auth);

      const released = await request(
        "POST",
        `/api/conversations/${CUSTOMER}/release`,
        first.auth,
      );
      expect(released.status).toBe(200);
      expect(await assignedAgent()).toBeNull();

      const next = await newAgent();
      expect((await takeover(next.auth)).status).toBe(200);
      expect(await assignedAgent()).toBe(next.userId);
    });
  });

  describe("an assignment waiting to be accepted", () => {
    const TEN_MINUTES = 10 * 60 * 1000;

    async function state() {
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

    async function assignedTo(userId: string, notifiedAt = Date.now()) {
      await run(
        `UPDATE conversations
         SET assigned_agent = ?, assignment_notified_at = ?, status = 'human_takeover',
             handover_reason = 'multiple_objections'
         WHERE tenant_id = ? AND phone_number = ?`,
        [userId, notifiedAt, tenant.tenantId, CUSTOMER],
      );
    }

    async function goOffline(userId: string) {
      await run(
        "UPDATE tenant_memberships SET is_available = 0 WHERE tenant_id = ? AND user_id = ?",
        [tenant.tenantId, userId],
      );
    }

    const decline = (auth: Auth) =>
      request(
        "POST",
        `/api/conversations/${CUSTOMER}/decline-assignment`,
        auth,
      );

    it("is accepted by the takeover, so the timer leaves the conversation with the agent", async () => {
      const agent = await newAgent();
      await newAgent();
      await assignedTo(agent.userId, Date.now() - TEN_MINUTES);

      expect((await takeover(agent.auth)).status).toBe(200);
      expect((await state()).notifiedAt).toBeNull();

      await checkAndReassignTimeouts();

      expect((await state()).assignedAgent).toBe(agent.userId);
    });

    it("goes to the next agent when it times out, and the conversation stays with a person", async () => {
      const silent = await newAgent();
      const next = await newAgent();
      await goOffline(silent.userId);
      await assignedTo(silent.userId, Date.now() - TEN_MINUTES);

      await checkAndReassignTimeouts();

      expect(await state()).toMatchObject({
        assignedAgent: next.userId,
        status: "human_takeover",
        handoverReason: "multiple_objections",
      });
      expect((await state()).notifiedAt).toBeGreaterThan(
        Date.now() - TEN_MINUTES,
      );
    });

    it("is not reassigned before the window passes", async () => {
      const agent = await newAgent();
      await newAgent();
      await assignedTo(agent.userId);

      await checkAndReassignTimeouts();

      expect((await state()).assignedAgent).toBe(agent.userId);
    });

    describe("declined by the agent", () => {
      it("goes to the next agent and moves a conversation the bot owned to a person", async () => {
        const first = await newAgent();
        const next = await newAgent();
        await goOffline(first.userId);
        await run(
          "UPDATE conversations SET assigned_agent = ? WHERE tenant_id = ? AND phone_number = ?",
          [first.userId, tenant.tenantId, CUSTOMER],
        );
        expect(await state()).toMatchObject({
          status: "active",
        });

        const response = await decline(first.auth);

        expect(response.status).toBe(200);
        expect(await state()).toMatchObject({
          assignedAgent: next.userId,
          status: "human_takeover",
        });
        expect((await state()).notifiedAt).toBeGreaterThan(0);
      });

      it("leaves a conversation the bot owned escalated and unassigned when no other agent is available", async () => {
        const only = await newAgent();
        await goOffline(only.userId);
        await run(
          "UPDATE conversations SET assigned_agent = ? WHERE tenant_id = ? AND phone_number = ?",
          [only.userId, tenant.tenantId, CUSTOMER],
        );
        expect(await state()).toMatchObject({
          status: "active",
        });

        const response = await decline(only.auth);

        expect(response.status).toBe(200);
        expect(await state()).toEqual({
          assignedAgent: null,
          notifiedAt: null,
          status: "human_takeover",
          handoverReason: "agent_assigned",
        });
      });

      it("does not let an agent decline a conversation held by another", async () => {
        const holder = await newAgent();
        const other = await newAgent();
        await assignedTo(holder.userId);

        const response = await decline(other.auth);

        expect(response.status).toBe(404);
        expect((await state()).assignedAgent).toBe(holder.userId);
      });

      it("answers busy and changes nothing while the conversation is locked", async () => {
        const agent = await newAgent();
        await newAgent();
        await assignedTo(agent.userId);
        const before = await state();

        const response = await whileLocked(tenant.ref(CUSTOMER), () =>
          decline(agent.auth),
        );

        expect(response.status).toBe(409);
        expect(await state()).toEqual(before);
      });
    });
  });

  describe("demoting an agent", () => {
    it("clears their conversations", async () => {
      const agent = await newAgent();
      await takeover(agent.auth);

      const response = await request(
        "PATCH",
        `/api/admin/users/${agent.userId}/role`,
        admin,
        { role: "supervisor" },
      );

      expect(response.status).toBe(200);
      expect(await assignedAgent()).toBeNull();
    });

    it("keeps them when the role is set to the one the agent already has", async () => {
      const agent = await newAgent();
      await takeover(agent.auth);

      await request("PATCH", `/api/admin/users/${agent.userId}/role`, admin, {
        role: "sales_agent",
      });

      expect(await assignedAgent()).toBe(agent.userId);
    });
  });
});
