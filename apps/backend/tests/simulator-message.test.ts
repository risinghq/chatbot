/**
 * The simulator answers in the request, with no queue to retry the turn. A turn
 * that throws before it is recorded tells the caller instead of reporting the
 * message as processed, and a business without an OpenAI key is told so before
 * any turn runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import type { ConversationPhase } from "@vendeya/core";

import { enrichmentRegistry } from "../src/conversation/enrichment/registry.ts";
import { TenantSecrets } from "../src/domains/settings/tenant-secrets.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import simulatorRoutes from "../src/routes/simulator.ts";
import {
  createMember,
  insertConversation,
  insertTenant,
  simulatorRef,
} from "./helpers/tenancy.ts";

const SIMULATOR_PHONE = "51999999999";

const OBJECTION: ConversationPhase = {
  phase: "handling_objection",
  segment: "fnb",
  credit: 3000,
  name: "Ana",
  objectionCount: 1,
};

describe("a simulated message", () => {
  let app: Hono;
  let tenantId: string;
  let cookie: string;

  // The business has no WhatsApp number: the simulator must not need one.
  beforeEach(async () => {
    app = new Hono();
    app.use("/api/*", requireAuth);
    app.route("/api/simulator", simulatorRoutes);

    tenantId = await insertTenant("simulator-failed-turn");
    await insertConversation(await simulatorRef(tenantId, SIMULATOR_PHONE), {
      isSimulation: true,
      contextData: {
        phase: OBJECTION,
        metadata: { createdAt: Date.now(), lastActivityAt: Date.now() },
      },
    });

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
      (await createMember({ tenantId }, "admin")).userId,
      tenantId,
    );
    cookie = `session=${token}`;
  });

  afterEach(async () => {
    enrichmentRegistry.clear();
  });

  function send() {
    return app.request("/api/simulator/message", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        phoneNumber: SIMULATOR_PHONE,
        message: "mmm lo voy a pensar",
      }),
    });
  }

  it("answers 409 while the business has no OpenAI key", async () => {
    const response = await send();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "no_openai_key" });
  });

  it("answers failed with the reason when the turn throws", async () => {
    await TenantSecrets.set(tenantId, "openai_api_key", "sk-test");

    const response = await send();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: "failed",
      error: "the model is down",
    });
  });

  it("creates a simulation with no WhatsApp number", async () => {
    const response = await app.request("/api/simulator/conversations", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ is_simulation: 1 });
  });
});
