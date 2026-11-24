/**
 * Each business has one simulator channel, where the dashboard's simulator
 * talks. It is not a WhatsApp number: the number listings and the default
 * account leave it out, and nothing is ever sent through it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sendResolved } from "../src/adapters/whatsapp/index.ts";
import { ChannelAccountService } from "../src/domains/channels/accounts.ts";
import {
  createTenantFixture,
  insertTenant,
  simulatorRef,
  type TenantFixture,
} from "./helpers/tenancy.ts";

describe("the simulator channel", () => {
  let tenant: TenantFixture;
  let originalFetch: typeof globalThis.fetch;
  let fetched: number;

  beforeEach(async () => {
    tenant = await createTenantFixture("simulator-channel");
    originalFetch = globalThis.fetch;
    fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("{}");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is one per business", async () => {
    const first = await ChannelAccountService.simulatorFor(tenant.tenantId);
    const second = await ChannelAccountService.simulatorFor(tenant.tenantId);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      tenant_id: tenant.tenantId,
      channel_type: "simulator",
    });
  });

  it("is left out of the business's numbers and its default", async () => {
    await ChannelAccountService.simulatorFor(tenant.tenantId);

    const listed = await ChannelAccountService.listForTenant(tenant.tenantId);
    expect(listed.map((account) => account.id)).toEqual([
      tenant.channelAccountId,
    ]);
    expect(
      (await ChannelAccountService.getDefaultForTenant(tenant.tenantId))?.id,
    ).toBe(tenant.channelAccountId);
  });

  it("is no default for a business without a number", async () => {
    const tenantId = await insertTenant("simulator-only");
    await ChannelAccountService.simulatorFor(tenantId);

    expect(
      await ChannelAccountService.getDefaultForTenant(tenantId),
    ).toBeNull();
  });

  it("refuses a send without calling WhatsApp", async () => {
    const outcome = await sendResolved(
      await simulatorRef(tenant.tenantId, "51900000001"),
      { type: "text", content: "hola" },
    );

    expect(outcome).toEqual({
      ok: false,
      kind: "permanent",
      reason: "simulator",
    });
    expect(fetched).toBe(0);
  });
});
