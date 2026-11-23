/**
 * A business's assistant settings: any member reads them, an admin,
 * developer or supervisor changes them, and a business that never saved them
 * runs on the defaults.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { ASSISTANT_MODELS, type AssistantSettings } from "@vendeya/types";

import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import assistantRoutes from "../src/routes/assistant.ts";
import { StockService } from "../src/domains/stock/index.ts";
import { createMember, createTenantFixture } from "./helpers/tenancy.ts";

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api/assistant", assistantRoutes);
app.onError(errorHandler);

type Caller = (method: string, body?: unknown) => Promise<Response>;

async function callerAs(
  tenantId: string,
  role: "admin" | "sales_agent",
): Promise<Caller> {
  const { userId } = await createMember({ tenantId }, role);
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);
  return async (method, body) =>
    await app.request("/api/assistant/settings", {
      method,
      headers: {
        Cookie: `session=${token}`,
        "X-Tenant-Id": tenantId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

describe("assistant settings", () => {
  let tenantId: string;
  let admin: Caller;

  beforeEach(async () => {
    ({ tenantId } = await createTenantFixture("assistant-settings"));
    admin = await callerAs(tenantId, "admin");
  });

  it("start at the defaults", async () => {
    expect(await json<AssistantSettings>(await admin("GET"), 200)).toEqual({
      instructions: "",
      faq: "",
      policies: "",
      model: ASSISTANT_MODELS[0],
      stock_location_id: null,
      updated_at: null,
    });
  });

  it("keep the fields an update leaves out", async () => {
    await json(
      await admin("PUT", {
        instructions: "  Trata de usted.  ",
        faq: "Envíos en 48 h",
      }),
      200,
    );
    const saved = await json<AssistantSettings>(
      await admin("PUT", { model: "gpt-5" }),
      200,
    );

    expect(saved).toMatchObject({
      instructions: "Trata de usted.",
      faq: "Envíos en 48 h",
      model: "gpt-5",
    });
    expect(saved.updated_at).toEqual(expect.any(Number));
  });

  it("refuse an unknown model and another business's location", async () => {
    expect((await admin("PUT", { model: "gpt-2" })).status).toBe(400);

    const other = await createTenantFixture("assistant-settings-other");
    const elsewhere = await StockService.createLocation(other.tenantId, "Otro");
    expect(
      (await admin("PUT", { stock_location_id: elsewhere!.id })).status,
    ).toBe(400);

    const own = await StockService.createLocation(tenantId, "Tienda");
    const saved = await json<AssistantSettings>(
      await admin("PUT", { stock_location_id: own!.id }),
      200,
    );
    expect(saved.stock_location_id).toBe(own!.id);
  });

  it("are read but not changed by a sales agent", async () => {
    const agent = await callerAs(tenantId, "sales_agent");
    expect((await agent("GET")).status).toBe(200);
    expect((await agent("PUT", { faq: "x" })).status).toBe(403);
  });

  it("belong to one business", async () => {
    await json(await admin("PUT", { faq: "solo aquí" }), 200);
    const other = await createTenantFixture("assistant-settings-third");
    const otherAdmin = await callerAs(other.tenantId, "admin");
    expect(
      await json<AssistantSettings>(await otherAdmin("GET"), 200),
    ).toMatchObject({ faq: "" });
  });
});
