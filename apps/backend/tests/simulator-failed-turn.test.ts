/**
 * The simulator answers in the request, with no queue to retry the turn. A turn
 * that throws before it is recorded tells the caller instead of reporting the
 * message as processed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import type { ConversationPhase } from "@vendeya/core";

import { enrichmentRegistry } from "../src/conversation/enrichment/registry.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import simulatorRoutes from "../src/routes/simulator.ts";
import {
  createMember,
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

const SIMULATOR_PHONE = "51999999999";

const OBJECTION: ConversationPhase = {
  phase: "handling_objection",
  segment: "fnb",
  credit: 3000,
  name: "Ana",
  objectionCount: 1,
};

describe("a simulated message whose turn fails", () => {
  let app: Hono;
  let tenant: TenantFixture;
  let cookie: string;

  beforeEach(async () => {
    app = new Hono();
    app.use("/api/*", requireAuth);
    app.route("/api/simulator", simulatorRoutes);

    tenant = await createTenantFixture("simulator-failed-turn");
    const account = (await ChannelAccountService.getDefaultForTenant(
      tenant.tenantId,
    ))!;
    await insertConversation(
      {
        tenantId: tenant.tenantId,
        channelAccountId: account.id,
        phoneNumber: SIMULATOR_PHONE,
      },
      {
        isSimulation: true,
        contextData: {
          phase: OBJECTION,
          metadata: { createdAt: Date.now(), lastActivityAt: Date.now() },
        },
      },
    );

    enrichmentRegistry.clear();
    enrichmentRegistry.register({
      type: "detect_question",
      execute: async () => {
        throw new Error("the model is down");
      },
    });

    const token = generateSessionToken();
    await createSession(
      token,
      (await createMember(tenant, "admin")).userId,
      tenant.tenantId,
    );
    cookie = `session=${token}`;
  });

  afterEach(async () => {
    enrichmentRegistry.clear();
  });

  it("answers failed with the reason instead of processed", async () => {
    const response = await app.request("/api/simulator/message", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumber: SIMULATOR_PHONE,
        message: "mmm lo voy a pensar",
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: "failed",
      error: "the model is down",
    });
  });
});
