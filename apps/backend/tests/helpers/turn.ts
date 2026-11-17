import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import worker from "../../src/index.ts";
import { run } from "../../src/db/index.ts";
import { conversationStub } from "../../src/conversation/stub.ts";
import type { ConversationObject } from "../../src/conversation/object.ts";
import { TIMEOUTS } from "../../src/config/timeouts.ts";
import { sweep } from "../../src/sweep.ts";
import type { ConversationRef } from "@vendeya/types";
import { inboundText, signedWebhookRequest } from "./webhook.ts";
import type { TenantFixture } from "./tenancy.ts";

/**
 * A request to the backend Worker, with everything it hands to `waitUntil`
 * finished before this returns.
 */
export async function backendFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(new URL(path, "https://vendeya.test"), init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** Meta delivering one signed text message to the number `phoneNumberId`. */
export async function deliver(
  phoneNumberId: string,
  from: string,
  text: string,
): Promise<Response> {
  // Old enough that `calculateResponseDelay` adds no pacing to the turn.
  const sentAt = Date.now() - 11 * 60 * 1000;
  return backendFetch(
    "/api/webhook",
    await signedWebhookRequest(
      inboundText(phoneNumberId, from, text, { sentAt }),
    ),
  );
}

/**
 * Moves the conversation's pending messages past the quiet window and fires
 * its alarm, which answers them as one turn. Returns whether an alarm ran.
 */
export async function quietWindowPasses(
  ref: ConversationRef,
): Promise<boolean> {
  await run(
    `UPDATE message_inbox SET created_at = created_at - 60000
     WHERE tenant_id = ? AND channel_account_id = ? AND phone_number = ? AND status = 'pending'`,
    [ref.tenantId, ref.channelAccountId, ref.phoneNumber],
  );
  return runDurableObjectAlarm(conversationStub(ref));
}

/**
 * The customer writes in over the signed webhook and the turn runs, with no
 * wait for the quiet window.
 */
export async function customerWrites(
  tenant: TenantFixture,
  phoneNumber: string,
  text: string,
): Promise<void> {
  const response = await deliver(tenant.phoneNumberId, phoneNumber, text);
  expect(response.status).toBe(200);
  await quietWindowPasses(tenant.ref(phoneNumber));
}

/** A request to the webhook route. `path` is `/` with an optional query. */
export function webhookRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return backendFetch(`/api/webhook${path.replace(/^\//, "")}`, init);
}

/**
 * Runs `fn` while the conversation's lock is held, as a long turn holds it,
 * with the lock timeout cut to 30 ms so a caller gives up at once. The lock
 * is taken inside the object, which may await only promises it made.
 */
export async function whileLocked<T>(
  ref: ConversationRef,
  fn: () => Promise<T>,
): Promise<T> {
  const timeouts = TIMEOUTS as { LOCK_DEFAULT: number };
  const saved = timeouts.LOCK_DEFAULT;
  return runInDurableObject(
    conversationStub(ref),
    async (object: ConversationObject) => {
      const release = await object.lock.acquire();
      timeouts.LOCK_DEFAULT = 30;
      try {
        return await fn();
      } finally {
        timeouts.LOCK_DEFAULT = saved;
        release();
      }
    },
  );
}

/**
 * Wakes the conversation's object with the clock at `at`, as its alarm would
 * at that moment. The caller restores the clock with `vi.useRealTimers()`.
 */
export async function wakeAt(ref: ConversationRef, at: number): Promise<void> {
  vi.setSystemTime(at);
  await conversationStub(ref).wake(ref);
}

/**
 * Runs the cron trigger's sweep. With `at`, the clock is set there first, and
 * the caller restores it with `vi.useRealTimers()`.
 */
export async function sweepAt(at?: number): Promise<void> {
  if (at !== undefined) vi.setSystemTime(at);
  await sweep(at ?? Date.now());
}
