/**
 * A wake is a call into the conversation's object, one subrequest each, and
 * an invocation may not spend more than the budget the bound stands for. A
 * due set bigger than the bound is woken over successive sweeps instead of
 * failing its tail every minute.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { getOne, run } from "../src/db/index.ts";
import { sweep } from "../src/sweep.ts";
import {
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

const BOUND = 2;
const CUSTOMERS = ["51900111001", "51900111002", "51900111003"];

describe("a sweep with more due conversations than its wake bound", () => {
  let tenant: TenantFixture;

  beforeEach(async () => {
    tenant = await createTenantFixture("sweep-bound");
    for (const [index, phone] of CUSTOMERS.entries()) {
      await insertConversation(tenant.ref(phone));
      // A row an ended object left mid-turn makes the conversation due; the
      // wake settles it as the second, failing attempt.
      await run(
        `INSERT INTO message_inbox
           (tenant_id, channel_account_id, phone_number, message_text,
            message_id, whatsapp_timestamp, status, attempts, created_at)
         VALUES (?, ?, ?, 'stuck', ?, 1, 'processing', 1, ?)`,
        [
          tenant.tenantId,
          tenant.channelAccountId,
          phone,
          `wamid-stuck-${index}`,
          Date.now() - 60_000,
        ],
      );
    }
  });

  async function settled(): Promise<number> {
    return (
      (
        (await getOne(
          `SELECT COUNT(*) AS n FROM message_inbox
           WHERE tenant_id = ? AND status = 'failed'`,
          [tenant.tenantId],
        )) as { n: number }
      ).n ?? 0
    );
  }

  it("wakes up to the bound each minute, reaching the rest on later sweeps", async () => {
    const now = Date.now();

    await sweep(now, BOUND);
    expect(await settled()).toBe(BOUND);

    await sweep(now, BOUND);
    expect(await settled()).toBe(CUSTOMERS.length);
  });
});
