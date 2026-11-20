/**
 * Messages already queued for a number that is switched off must stay where
 * they are: a queued row stays `pending`. A refused send that only recorded a
 * failure would let the worker mark the row processed, leaving nothing to
 * recover once the number is on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getAll, getOne, run } from "../src/db/index.ts";
import {
  addChannelAccount,
  createMember,
  createTenantFixture,
  insertConversation,
  type TenantFixture,
  setChannelStatus,
} from "./helpers/tenancy.ts";

import {
  conversationsWithWaitingMessages,
  pendingGroup,
} from "../src/conversation/message-inbox.ts";
import { conversationStub } from "../src/conversation/stub.ts";
import { checkAndReassignTimeouts } from "../src/domains/conversations/assignment.ts";
import { answerMessage } from "../src/conversation/handler/index.ts";
import {
  ChannelUnavailableError,
  WhatsAppService,
} from "../src/adapters/whatsapp/index.ts";
import { MessageStore } from "../src/adapters/whatsapp/message-store.ts";
import type { ChannelAccount, ConversationRef } from "@vendeya/types";
import { fakeModel, withOpenAiKey } from "./helpers/model.ts";

const CUSTOMER = "51900444555";

/** Old enough that the aggregator's quiet window has long since passed. */
const QUEUED_AT = () => Date.now() - 60_000;

describe("a channel account that is not active", () => {
  let tenant: TenantFixture;
  /** A second number for the same business, left on throughout. */
  let untouched: Awaited<ReturnType<typeof addChannelAccount>>;
  let sends: number;
  let originalFetch: typeof globalThis.fetch;

  async function setStatus(
    channelAccountId: string,
    status: ChannelAccount["status"],
  ): Promise<void> {
    await setChannelStatus(channelAccountId, status);
  }

  async function answerQueued(ref: ConversationRef): Promise<void> {
    await conversationStub(ref).wake(ref);
  }

  async function waitingAccounts(): Promise<string[]> {
    return (await conversationsWithWaitingMessages(Date.now())).map(
      (ref) => ref.channelAccountId,
    );
  }

  async function queue(ref: ConversationRef, text: string): Promise<void> {
    await run(
      `INSERT INTO message_inbox
         (tenant_id, channel_account_id, phone_number, message_text, message_id,
          whatsapp_timestamp, status, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 'pending', ?)`,
      [
        ref.tenantId,
        ref.channelAccountId,
        ref.phoneNumber,
        text,
        `wamid-${crypto.randomUUID()}`,
        QUEUED_AT(),
      ],
    );
  }

  /** Every inbox row for one number, by status. */
  async function queueStatuses(channelAccountId: string): Promise<string[]> {
    return (
      (await getAll(
        "SELECT status FROM message_inbox WHERE channel_account_id = ? ORDER BY id",
        [channelAccountId],
      )) as Array<{ status: string }>
    ).map((row) => row.status);
  }

  beforeEach(async () => {
    tenant = await createTenantFixture("channel-off");
    untouched = await addChannelAccount(tenant);

    // Tests here must not reach Meta. The fake fetch counts sends so that a
    // send that got out fails the test.
    sends = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      sends++;
      return new Response(JSON.stringify({ error: "no network in tests" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
  });

  for (const status of ["disabled", "pending"] as const) {
    describe(`(${status}) is left out of the aggregator`, () => {
      it("while the business's other number is still served", async () => {
        await queue(tenant.ref(CUSTOMER), "hola");
        await queue(untouched.ref(CUSTOMER), "hola");

        expect(await waitingAccounts()).toEqual(
          expect.arrayContaining([
            tenant.channelAccountId,
            untouched.channelAccountId,
          ]),
        );

        await setStatus(tenant.channelAccountId, status);

        expect(await waitingAccounts()).not.toContain(tenant.channelAccountId);
        expect(await pendingGroup(tenant.ref(CUSTOMER))).toBeUndefined();
        expect(await waitingAccounts()).toContain(untouched.channelAccountId);
        expect(await pendingGroup(untouched.ref(CUSTOMER))).toBeDefined();
      });
    });

    describe(`(${status}) is left out of timeout reassignment`, () => {
      /** A conversation whose agent was paged and never answered. */
      async function abandoned(
        ref: ConversationRef,
        agentId: string,
        notifiedAt: number,
      ): Promise<void> {
        await insertConversation(ref, {
          status: "human_takeover",
          assignedAgent: agentId,
        });
        await run(
          `UPDATE conversations SET assignment_notified_at = ?
           WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ?`,
          [notifiedAt, ref.tenantId, ref.channelAccountId, ref.phoneNumber],
        );
      }

      async function notifiedAt(
        channelAccountId: string,
      ): Promise<number | null> {
        return (
          (await getOne(
            "SELECT assignment_notified_at FROM conversations WHERE channel_account_id = ?",
            [channelAccountId],
          )) as { assignment_notified_at: number | null }
        ).assignment_notified_at;
      }

      it("while the business's other number is still reassigned", async () => {
        const agent = await createMember(tenant, "sales_agent");
        const stale = Date.now() - 10 * 60 * 1000;
        await abandoned(tenant.ref(CUSTOMER), agent.userId, stale);
        await abandoned(untouched.ref(CUSTOMER), agent.userId, stale);

        await setStatus(tenant.channelAccountId, status);

        await checkAndReassignTimeouts();

        expect(await notifiedAt(tenant.channelAccountId)).toBe(stale);
        expect(await notifiedAt(untouched.channelAccountId)).toBeGreaterThan(
          stale,
        );
      });
    });
  }

  describe("running the aggregator over a message queued for it", () => {
    beforeEach(async () => {
      await insertConversation(tenant.ref(CUSTOMER));
      await queue(tenant.ref(CUSTOMER), "¿sigue disponible?");
      await setStatus(tenant.channelAccountId, "disabled");
    });

    it("leaves the message on the queue instead of dropping it", async () => {
      await answerQueued(tenant.ref(CUSTOMER));

      // The row must stay 'pending'. It is the only record that this reply is
      // owed.
      expect(await queueStatuses(tenant.channelAccountId)).toEqual(["pending"]);
      expect(sends).toBe(0);
    });

    it("answers it once the number is switched back on", async () => {
      await answerQueued(tenant.ref(CUSTOMER));
      expect(await queueStatuses(tenant.channelAccountId)).toEqual(["pending"]);

      await setStatus(tenant.channelAccountId, "active");

      await answerQueued(tenant.ref(CUSTOMER));

      expect(await queueStatuses(tenant.channelAccountId)).toEqual([
        "processed",
      ]);
    });
  });

  /**
   * The aggregator's filter cannot cover a number switched off after its turn
   * started. The turn must see the refusal as a thrown error, because a
   * recorded failure alone would let it mark the row processed. The turn
   * itself is in interrupted-transition.test.ts.
   */
  describe("switched off after its messages were already dequeued", () => {
    it("refuses the send by throwing rather than recording a quiet failure", async () => {
      const ref = tenant.ref(CUSTOMER);
      await insertConversation(ref);
      await setStatus(tenant.channelAccountId, "disabled");

      await expect(
        WhatsAppService.sendMessage(ref, "¿Sigue ahí?"),
      ).rejects.toThrow(ChannelUnavailableError);

      expect((await MessageStore.getHistory(ref))[0]).toMatchObject({
        direction: "outbound",
        status: "failed",
      });
      expect(sends).toBe(0);
    });

    it("is passed on by the handler rather than absorbed as a processing error", async () => {
      const ref = tenant.ref(CUSTOMER);
      await insertConversation(ref);
      await setStatus(tenant.channelAccountId, "disabled");
      await withOpenAiKey(tenant.tenantId);
      const model = fakeModel();

      // `answerMessage` absorbs other processing errors after logging them. It
      // must rethrow this one so the turn sees the refusal.
      try {
        await expect(
          answerMessage({
            ref,
            content: "hola",
            timestamp: Date.now(),
            messageId: "wamid-race",
          }),
        ).rejects.toThrow(ChannelUnavailableError);
      } finally {
        model.restore();
      }
    });
  });
});
