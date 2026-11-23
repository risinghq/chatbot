/**
 * The simulator answers in the request, with no queue to retry the turn. A turn
 * that throws before it is recorded tells the caller instead of reporting the
 * message as processed, and a business without an OpenAI key is told so before
 * any turn runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import { getAll } from "./helpers/db.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import simulatorRoutes from "../src/routes/simulator.ts";
import { type FakeModel, fakeModel, withOpenAiKey } from "./helpers/model.ts";
import {
  createMember,
  insertConversation,
  insertTenant,
  simulatorRef,
} from "./helpers/tenancy.ts";

const SIMULATOR_PHONE = "51999999999";

describe("a simulated message", () => {
  let app: Hono;
  let tenantId: string;
  let cookie: string;
  let model: FakeModel;

  // The business has no WhatsApp number: the simulator must not need one.
  beforeEach(async () => {
    app = new Hono();
    app.use("/api/*", requireAuth);
    app.route("/api/simulator", simulatorRoutes);

    tenantId = await insertTenant("simulator-failed-turn");
    await insertConversation(await simulatorRef(tenantId, SIMULATOR_PHONE), {
      isSimulation: true,
    });

    const token = generateSessionToken();
    await createSession(
      token,
      (await createMember({ tenantId }, "admin")).userId,
      tenantId,
    );
    cookie = `session=${token}`;
    model = fakeModel();
  });

  afterEach(() => {
    model.restore();
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
    expect(model.requests).toHaveLength(0);
  });

  it("reports whether the business has an OpenAI key", async () => {
    const status = async () => {
      const response = await app.request("/api/simulator/status", {
        headers: { Cookie: cookie },
      });
      return response.json();
    };

    expect(await status()).toEqual({ hasOpenAiKey: false });
    await withOpenAiKey(tenantId);
    expect(await status()).toEqual({ hasOpenAiKey: true });
  });

  it("records the assistant's reply in the conversation", async () => {
    await withOpenAiKey(tenantId);
    model.says("Claro, aquí estaré.");

    const response = await send();

    expect(await response.json()).toEqual({ status: "processed" });
    const messages = await getAll<{ direction: string; content: string }>(
      "SELECT direction, content FROM messages WHERE tenant_id = ? ORDER BY created_at, id",
      [tenantId],
    );
    expect(messages).toEqual([
      { direction: "inbound", content: "mmm lo voy a pensar" },
      { direction: "outbound", content: "Claro, aquí estaré." },
    ]);
  });

  it("answers failed with the reason when the model fails", async () => {
    await withOpenAiKey(tenantId);
    model.fails();

    const response = await send();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: "failed",
      error: "The assistant model did not answer",
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
