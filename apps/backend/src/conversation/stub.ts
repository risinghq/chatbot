import { env } from "cloudflare:workers";
import type { ConversationRef } from "@vendeya/types";
import { ConversationBusyError, lockKey } from "./locks.ts";

/**
 * What a locked call on the conversation's object returns. `busy` means the
 * lock did not come free, or the work outlasted the lock timeout and is still
 * running. An RPC error loses its class, so the object answers `busy` instead
 * of throwing.
 */
export type Locked<T> = { busy: true } | { busy: false; value: T };

/**
 * The one object that serializes every write to this conversation. Its name is
 * the whole conversation identity, so the same contact writing to two
 * businesses gets two objects.
 */
export function conversationStub(ref: ConversationRef) {
  return env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(lockKey(ref)));
}

/** @throws ConversationBusyError when the object answered `busy` */
export function unlocked<T>(ref: ConversationRef, result: Locked<T>): T {
  if (result.busy) throw new ConversationBusyError(lockKey(ref));
  return result.value;
}
