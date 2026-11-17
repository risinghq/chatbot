import { DurableObject } from "cloudflare:workers";
import type { ConversationRef } from "@vendeya/types";
import {
  declineHeld,
  releaseHeld,
  takeoverHeld,
  type WriteResult,
} from "../domains/conversations/write.ts";
import { reassignIfStillWaiting } from "../domains/conversations/assignment.ts";
import { createLogger } from "../lib/logger.ts";
import { answerPendingMessages } from "./aggregator.ts";
import { answerMessage, type IncomingMessage } from "./handler/index.ts";
import { handOff } from "./handoff.ts";
import {
  ConversationBusyError,
  ConversationLock,
  LockTimeoutError,
  withLock,
} from "./locks.ts";
import {
  groupReadyAt,
  pendingGroup,
  recoverInterruptedTurns,
} from "./message-inbox.ts";
import { outboxWakeAt } from "./outbox.ts";
import {
  passClock,
  recoverInterruptedSends,
  sendDueReplies,
} from "./outbox-sender.ts";
import type { Locked } from "./stub.ts";

const logger = createLogger("conversation-object");

const REF_KEY = "ref";

/**
 * One object per conversation, named by `conversationStub`. Every write that
 * must not interleave with a bot turn runs here, under the lock in this
 * instance's memory: the turn, the outbox sends, the handoff, a takeover, a
 * release, a decline and a timed-out reassignment.
 *
 * The alarm is the conversation's next due moment: the end of the quiet window
 * of its pending messages, or the next outbox attempt. Every locked call ends
 * by setting it again from the database, so the alarm never outlives the work
 * it stands for.
 *
 * A row left `processing` or `sending` belongs to a call that ended mid-turn:
 * the object died with it, or the write that records the outcome threw. Every
 * locked call settles those rows before anything else, because the lock means
 * none of them can still be running.
 */
export class ConversationObject extends DurableObject<Env> {
  /** Public so a test can hold it, as a long turn would. */
  readonly lock = new ConversationLock();
  #ref: ConversationRef | undefined;

  /** Runs whatever the conversation owes now and sets the alarm for the rest. */
  wake(ref: ConversationRef): Promise<Locked<void>> {
    return this.#locked(ref, () => this.#pass(ref));
  }

  takeover(ref: ConversationRef, userId: string): Promise<Locked<WriteResult>> {
    return this.#locked(ref, () => takeoverHeld(ref, userId));
  }

  release(ref: ConversationRef, userId: string): Promise<Locked<void>> {
    return this.#locked(ref, () => releaseHeld(ref, userId));
  }

  decline(ref: ConversationRef, userId: string): Promise<Locked<WriteResult>> {
    return this.#locked(ref, () => declineHeld(ref, userId));
  }

  reassign(ref: ConversationRef, cutoff: number): Promise<Locked<void>> {
    return this.#locked(ref, () => reassignIfStillWaiting(ref, cutoff));
  }

  /** A simulator turn, answered at once with no inbox rows. */
  simulate(message: IncomingMessage): Promise<Locked<void>> {
    return this.#locked(message.ref, () => answerMessage(message));
  }

  override async alarm(): Promise<void> {
    const ref =
      this.#ref ?? (await this.ctx.storage.get<ConversationRef>(REF_KEY));
    if (!ref) return;

    // A busy lock is left alone: the work holding it sets the alarm again
    // when it ends.
    await this.wake(ref);
  }

  async #pass(ref: ConversationRef): Promise<void> {
    const at = passClock(Date.now());
    await sendDueReplies(ref, at);
    await answerPendingMessages(ref, at());
    await handOff(ref, at);
  }

  async #locked<T>(
    ref: ConversationRef,
    fn: () => Promise<T>,
  ): Promise<Locked<T>> {
    await this.#remember(ref);

    try {
      const value = await withLock(this.lock, ref, async () => {
        await this.#recover(ref);
        try {
          return await fn();
        } finally {
          await this.#schedule(ref);
        }
      });
      return { busy: false, value };
    } catch (error) {
      if (
        error instanceof ConversationBusyError ||
        error instanceof LockTimeoutError
      ) {
        return { busy: true };
      }
      throw error;
    }
  }

  /** The alarm handler has no caller to name the conversation, so the first call stores it. */
  async #remember(ref: ConversationRef): Promise<void> {
    if (this.#ref) return;
    this.#ref = ref;
    await this.ctx.storage.put(REF_KEY, ref);
  }

  async #recover(ref: ConversationRef): Promise<void> {
    const turns = await recoverInterruptedTurns(ref);
    if (turns > 0) {
      logger.warn(
        { tenantId: ref.tenantId, rows: turns },
        "Settled inbox rows an ended turn left processing",
      );
    }
    await recoverInterruptedSends(ref);
  }

  async #schedule(ref: ConversationRef): Promise<void> {
    const pending = await pendingGroup(ref);
    const times = [
      await outboxWakeAt(ref),
      pending ? groupReadyAt(pending) : undefined,
    ].filter((time): time is number => time !== undefined);

    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...times), Date.now()));
  }
}
