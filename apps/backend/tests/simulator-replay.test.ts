/**
 * Loading a real conversation into the simulator. A business with two WhatsApp
 * numbers has two separate threads with the same contact, so the source is
 * resolved on the number it came in on, not through the default account.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import {
  createMember,
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

import { getOne, run } from "../src/db/index.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import simulatorRoutes from "../src/routes/simulator.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import type { ConversationRef } from "@vendeya/types";

const CUSTOMER = "51987651234";
const SIMULATOR_PHONE = "51999999999";

describe("replaying a conversation from a second WhatsApp number", () => {
  let app: Hono;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let cookie: string;

  /** The account the simulator itself runs on, and the one it is not. */
  let defaultAccountId: string;
  let sourceRef: ConversationRef;

  beforeEach(async () => {
    app = new Hono();
    app.use("/api/*", requireAuth);
    app.route("/api/simulator", simulatorRoutes);

    alpha = await createTenantFixture("alpha-replay");
    beta = await createTenantFixture("beta-replay");

    // A second number for the same business.
    const secondId = `ch-${crypto.randomUUID()}`;
    await run(
      `INSERT INTO channel_accounts (id, tenant_id, channel_type, phone_number_id, status)
       VALUES (?, ?, 'whatsapp', ?, 'active')`,
      [secondId, alpha.tenantId, `pnid-${crypto.randomUUID().slice(0, 8)}`],
    );

    // Whichever of the two is the default, the source is the other one.
    defaultAccountId = (await ChannelAccountService.getDefaultForTenant(
      alpha.tenantId,
    ))!.id;
    const sourceAccountId = [alpha.channelAccountId, secondId].find(
      (id) => id !== defaultAccountId,
    )!;

    sourceRef = {
      tenantId: alpha.tenantId,
      channelAccountId: sourceAccountId,
      phoneNumber: CUSTOMER,
    };

    await insertConversation(sourceRef, {
      clientName: "Cliente Segunda Línea",
    });
    await MessageStore.log(sourceRef, "inbound", "text", "hola");
    await MessageStore.log(
      sourceRef,
      "outbound",
      "text",
      "¡Hola! ¿En qué ayudo?",
    );

    const userId = (await createMember(alpha, "admin")).userId;
    const token = generateSessionToken();
    await createSession(token, userId, alpha.tenantId);
    cookie = `session=${token}`;
  });

  function load(body: unknown, auth = cookie) {
    return app.request("/api/simulator/load", {
      method: "POST",
      headers: { Cookie: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("loads the thread the named number owns", async () => {
    const response = await load({
      sourcePhone: CUSTOMER,
      sourceChannel: sourceRef.channelAccountId,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "loaded",
      simulatorPhone: SIMULATOR_PHONE,
      messageCount: 2,
    });
  });

  it("puts the replay on the number the simulator reads from", async () => {
    await load({
      sourcePhone: CUSTOMER,
      sourceChannel: sourceRef.channelAccountId,
    });

    // The simulator's own endpoints look the conversation up through the
    // tenant's default account, so the replay has to land there. It carries the
    // source conversation's client, not the source's number.
    const loaded = (await getOne(
      `SELECT client_name, is_simulation FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [alpha.tenantId, defaultAccountId, SIMULATOR_PHONE],
    )) as {
      client_name: string;
      is_simulation: number;
    };

    expect(loaded.client_name).toBe("Cliente Segunda Línea");
    expect(loaded.is_simulation).toBe(1);
  });

  it("does not read a source out of another tenant", async () => {
    await insertConversation(beta.ref(CUSTOMER), { clientName: "Beta Client" });

    const response = await load({
      sourcePhone: CUSTOMER,
      sourceChannel: beta.channelAccountId,
    });

    expect(response.status).toBe(404);
  });

  it("still defaults to the tenant's own number when none is named", async () => {
    const onDefault = "51987659999";
    await insertConversation(
      {
        tenantId: alpha.tenantId,
        channelAccountId: defaultAccountId,
        phoneNumber: onDefault,
      },
      { clientName: "Cliente Línea Principal" },
    );

    const response = await load({ sourcePhone: onDefault });

    expect(response.status).toBe(200);
  });
});

/**
 * Which simulations the simulator lists. Every action on a listed conversation
 * resolves its phone number through the tenant's default channel account, and
 * the frontend keys rows by phone number alone. The listing must show only what the actions can
 * reach, or a row on the other number opens an empty thread or answers 404.
 */
describe("listing simulated conversations", () => {
  let app: Hono;
  let tenant: TenantFixture;
  let cookie: string;
  let defaultAccountId: string;
  let otherAccountId: string;

  const SIMULATED = "51900000001";

  beforeEach(async () => {
    app = new Hono();
    app.use("/api/*", requireAuth);
    app.route("/api/simulator", simulatorRoutes);

    tenant = await createTenantFixture("alpha-sim-list");

    const secondId = `ch-${crypto.randomUUID()}`;
    await run(
      `INSERT INTO channel_accounts (id, tenant_id, channel_type, phone_number_id, status)
       VALUES (?, ?, 'whatsapp', ?, 'active')`,
      [secondId, tenant.tenantId, `pnid-${crypto.randomUUID().slice(0, 8)}`],
    );

    defaultAccountId = (await ChannelAccountService.getDefaultForTenant(
      tenant.tenantId,
    ))!.id;
    otherAccountId = [tenant.channelAccountId, secondId].find(
      (id) => id !== defaultAccountId,
    )!;

    // The same contact simulated on both of the business's numbers.
    for (const channelAccountId of [defaultAccountId, otherAccountId]) {
      await insertConversation(
        { tenantId: tenant.tenantId, channelAccountId, phoneNumber: SIMULATED },
        { isSimulation: true },
      );
    }

    const userId = (await createMember(tenant, "admin")).userId;
    const token = generateSessionToken();
    await createSession(token, userId, tenant.tenantId);
    cookie = `session=${token}`;
  });

  function list() {
    return app.request("/api/simulator/conversations", {
      headers: { Cookie: cookie },
    });
  }

  it("shows one row per contact, not one per number", async () => {
    const rows = (await (await list()).json()) as Array<{
      phone_number: string;
      channel_account_id: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      phone_number: SIMULATED,
      channel_account_id: defaultAccountId,
    });
  });

  it("lists the row the actions act on", async () => {
    const deleted = await app.request(
      `/api/simulator/conversations/${SIMULATED}`,
      { method: "DELETE", headers: { Cookie: cookie } },
    );

    expect(deleted.status).toBe(200);
    expect(await (await list()).json()).toEqual([]);

    // The other number's thread was never listed and was not touched either.
    expect(
      await getOne(
        `SELECT COUNT(*) as c FROM conversations
           WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
        [tenant.tenantId, otherAccountId, SIMULATED],
      ),
    ).toEqual({ c: 1 });
  });
});
