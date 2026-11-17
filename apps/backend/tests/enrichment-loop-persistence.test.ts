/** The executor persists the phase after sends, not during enrichment. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  ConversationMetadata,
  ConversationPhase,
  EnrichmentRequest,
} from "@vendeya/core";
import { createMockProvider } from "@vendeya/intelligence";

import { getOne } from "../src/db/index.ts";
import { enrichmentRegistry } from "../src/conversation/enrichment/registry.ts";
import { runEnrichmentLoop } from "../src/conversation/handler/enrichment-loop.ts";
import {
  createTenantFixture,
  insertConversation,
  type TenantFixture,
} from "./helpers/tenancy.ts";

const CUSTOMER = "51900777999";

describe("a turn that needs enrichment", () => {
  let tenant: TenantFixture;
  let metadata: ConversationMetadata;
  /** Captures the stored conversation while the eligibility handler runs. */
  let storedDuringCheck: StoredConversation | undefined;

  type StoredConversation = {
    phase: ConversationPhase;
    metadata: ConversationMetadata;
  };

  async function stored(): Promise<StoredConversation> {
    const row = (await getOne(
      `SELECT context_data FROM conversations
         WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
      [tenant.tenantId, tenant.channelAccountId, CUSTOMER],
    )) as {
      context_data: string;
    };
    return JSON.parse(row.context_data);
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("loop-persistence");
    await insertConversation(tenant.ref(CUSTOMER), {
      contextData: {
        phase: { phase: "collecting_dni" },
        metadata: { createdAt: 1, lastActivityAt: 1 },
      },
    });
    metadata = { createdAt: 1, lastActivityAt: 1 };
    storedDuringCheck = undefined;

    enrichmentRegistry.clear();
    enrichmentRegistry.register({
      type: "check_eligibility",
      async execute(
        _request: Extract<EnrichmentRequest, { type: "check_eligibility" }>,
      ) {
        storedDuringCheck = await stored();
        return { type: "eligibility_result", status: "not_eligible" };
      },
    });
  });

  afterEach(async () => {
    enrichmentRegistry.clear();
  });

  test("leaves the stored phase alone while its handler runs and after the loop returns", async () => {
    const result = await runEnrichmentLoop(
      { phase: "collecting_dni" },
      "11111111",
      metadata,
      tenant.ref(CUSTOMER),
      createMockProvider(),
    );

    expect(result.type).toBe("update");
    expect(storedDuringCheck?.phase).toEqual({ phase: "collecting_dni" });
    expect((await stored()).phase).toEqual({ phase: "collecting_dni" });
  });

  test("a handler that throws leaves the conversation where the customer left it", async () => {
    enrichmentRegistry.clear();
    enrichmentRegistry.register({
      type: "check_eligibility",
      async execute() {
        throw new Error("provider down");
      },
    });

    await expect(
      runEnrichmentLoop(
        { phase: "collecting_dni" },
        "11111111",
        metadata,
        tenant.ref(CUSTOMER),
        createMockProvider(),
      ),
    ).rejects.toThrow("provider down");

    expect((await stored()).phase).toEqual({ phase: "collecting_dni" });
  });
});
