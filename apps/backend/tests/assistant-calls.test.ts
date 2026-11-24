/** The Registro names each model call's customer the way the business knows them. */

import { describe, it, expect } from "vitest";

import { createTenantFixture } from "./helpers/tenancy.ts";
import { run } from "./helpers/db.ts";
import { getRecentLLMCalls } from "../src/intelligence/tracker.ts";

async function seedCall(
  tenant: { tenantId: string; channelAccountId: string },
  phone: string,
): Promise<void> {
  await run(
    `INSERT INTO llm_calls
       (id, tenant_id, channel_account_id, phone_number, operation, model,
        prompt, user_message, status, latency_ms)
     VALUES (?, ?, ?, ?, 'reply', 'test-model', 'p', 'm', 'success', 5)`,
    [crypto.randomUUID(), tenant.tenantId, tenant.channelAccountId, phone],
  );
}

describe("the assistant's calls", () => {
  it("carry the business's own name for the customer, or none", async () => {
    const tenant = await createTenantFixture("Calls");
    const other = await createTenantFixture("Other");
    await run(
      "INSERT INTO customers (id, tenant_id, name, phone) VALUES (?, ?, 'Rosa', '51900111222')",
      [crypto.randomUUID(), tenant.tenantId],
    );
    await run(
      "INSERT INTO customers (id, tenant_id, name, phone) VALUES (?, ?, 'Ajena', '51900333444')",
      [crypto.randomUUID(), other.tenantId],
    );
    await seedCall(tenant, "51900111222");
    await seedCall(tenant, "51900333444");

    const calls = await getRecentLLMCalls(tenant.tenantId);
    const names = Object.fromEntries(
      calls.map((c) => [c.phone_number, c.customer_name]),
    );

    expect(names).toEqual({ "51900111222": "Rosa", "51900333444": null });
  });
});
