/**
 * What the audit trail says about the platform-wide retry sweep. An operator
 * with no tenant selected sweeps every open tenant, and the run splits its
 * counts by tenant. A run that reaches no tenant gets one entry, so a no-op is
 * on the record too.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

import { getAll, run } from "../src/db/index.ts";
import {
  createTenantFixture,
  insertUser,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { requireAuth, requireRole } from "../src/middleware/auth.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import adminRoutes from "../src/routes/admin.ts";
import { RetryEligibilityHandler } from "../src/domains/recovery/handlers/retry-eligibility-handler.ts";
import type { CheckEligibilityHandler } from "../src/domains/eligibility/handlers/check-eligibility-handler.ts";
import { Ok } from "../src/shared/result/index.ts";

const CUSTOMER = "51900333444";

type AuditRow = {
  tenant_id: string | null;
  action: string;
  metadata: string;
};

function buildApp() {
  const app = new Hono();
  app.use("/api/*", requireAuth);
  app.use("/api/admin/*", requireRole("admin"));
  app.route("/api/admin", adminRoutes);
  return app;
}

/** Every audit entry for one action, whichever tenant it belongs to. */
async function entriesFor(action: string): Promise<AuditRow[]> {
  return (await getAll(
    "SELECT tenant_id, action, metadata FROM audit_log WHERE action = ? ORDER BY created_at",
    [action],
  )) as AuditRow[];
}

async function login(userId: string, tenantId: string | null): Promise<string> {
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);
  return `session=${token}`;
}

describe("auditing an operations sweep", () => {
  let app: ReturnType<typeof buildApp>;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let operator: string;

  beforeEach(async () => {
    app = buildApp();

    alpha = await createTenantFixture("alpha-ops");
    beta = await createTenantFixture("beta-ops");

    const operatorId = await insertUser({
      name: "Operator",
      isPlatformOperator: true,
    });

    // No tenant pinned: this is the cross-tenant support session.
    operator = await login(operatorId, null);
  });

  afterEach(async () => {
    await run("DELETE FROM audit_log WHERE tenant_id IS NULL");
  });

  function post(path: string, cookie: string) {
    return app.request(path, { method: "POST", headers: { Cookie: cookie } });
  }

  /**
   * The counts the entries are written from. Splitting them per tenant is what
   * makes an entry per tenant possible at all, so it is checked on the handler
   * as well as through the route.
   */
  it("splits the retry sweep's counts by tenant", async () => {
    for (const fixture of [alpha, beta]) {
      await run(
        `INSERT INTO conversations
           (tenant_id, channel_account_id, phone_number, context_data)
         VALUES (?, ?, ?, ?)`,
        [
          fixture.tenantId,
          fixture.channelAccountId,
          CUSTOMER,
          JSON.stringify({
            phase: { phase: "waiting_for_recovery", dni: "12345678" },
            metadata: { createdAt: Date.now(), lastActivityAt: Date.now() },
          }),
        ],
      );
    }

    // The provider is still down, so every conversation stays where it is and
    // nothing is sent. Only the bookkeeping is under test.
    const stillDown = {
      execute: async () =>
        Ok({ type: "eligibility_result", status: "system_outage" }),
    } as unknown as CheckEligibilityHandler;

    const result = await new RetryEligibilityHandler(stillDown).execute(null);

    if (!result.ok) throw new Error("Expected success result");

    expect(result.value.stillFailingCount).toBe(2);
    expect(result.value.byTenant).toEqual({
      [alpha.tenantId]: {
        recoveredCount: 0,
        stillFailingCount: 1,
        errors: 0,
      },
      [beta.tenantId]: {
        recoveredCount: 0,
        stillFailingCount: 1,
        errors: 0,
      },
    });
  });

  it("still records a sweep that reached no tenant", async () => {
    const response = await post("/api/admin/retry-eligibility", operator);
    expect(response.status).toBe(200);

    const entries = await entriesFor("retry_eligibility");

    expect(entries).toHaveLength(1);
    expect(entries[0]!.tenant_id).toBeNull();
    expect(JSON.parse(entries[0]!.metadata)).toMatchObject({
      tenantsAffected: 0,
      recoveredCount: 0,
    });
  });
});
