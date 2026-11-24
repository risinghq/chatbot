import { newId } from "@vendeya/utils";
import { createLogger } from "../../lib/logger.ts";
import { WhatsAppService } from "../../adapters/whatsapp/index.ts";
import { ChannelAccountService } from "../channels/accounts.ts";
import { NotificationResolver } from "./resolver.ts";
import { sendEventPush } from "./push.ts";
import type { NotificationDecision } from "./evaluator.ts";
import type { ChannelAccount, DomainEvent } from "@vendeya/types";
import { db, withoutTenantScope } from "../../db/index.ts";

const logger = createLogger("notification-dispatcher");

/**
 * What a send attempt did. "no_recipient" is not a failure: nobody opted in,
 * so there was nothing to deliver.
 */
type SendOutcome = "sent" | "no_recipient" | "failed";

interface NotificationChannelAdapter {
  /**
   * Whether the rule's target goes through NotificationResolver, which answers
   * a phone number. Push resolves its own users, so its target passes through.
   */
  resolvesTarget: boolean;
  /** Whether the send needs a channel account. Push needs none. */
  needsAccount: boolean;
  /** What the send attempt did. */
  send(
    account: ChannelAccount | null,
    target: string,
    content: string,
    event: DomainEvent,
  ): Promise<SendOutcome>;
}

const whatsAppAdapter: NotificationChannelAdapter = {
  resolvesTarget: true,
  needsAccount: true,
  async send(account: ChannelAccount | null, target: string, content: string) {
    if (!account || !target) return "no_recipient";
    return (await WhatsAppService.sendDirect(account, target, content))
      ? "sent"
      : "failed";
  },
};

const pushAdapter: NotificationChannelAdapter = {
  resolvesTarget: false,
  needsAccount: false,
  async send(_account, target, content, event) {
    return sendEventPush(target, content, event);
  },
};

const adapters: Record<string, NotificationChannelAdapter> = {
  whatsapp: whatsAppAdapter,
  push: pushAdapter,
};

/**
 * Picks the account a notification goes out on. The event's own channel account
 * wins, then its tenant's default account. A tenant's alert carries customer
 * data, so it must not leave from the platform's number. A tenant with no
 * account gets null and a failed trace. Only an event with no tenant, such as
 * both eligibility providers being down, uses the platform operations account.
 */
export async function accountForEvent(
  event: DomainEvent,
): Promise<ChannelAccount | null> {
  if (event.channelAccountId) {
    const account = await ChannelAccountService.getById(event.channelAccountId);
    if (account) return account;
  }

  if (event.tenantId) {
    return await ChannelAccountService.getDefaultForTenant(event.tenantId);
  }

  return await ChannelAccountService.getPlatformOps();
}

/** Reports whether at least one notification was delivered. */
export async function dispatchNotifications(
  decisions: NotificationDecision[],
  event: DomainEvent,
): Promise<boolean> {
  const now = Date.now();
  let delivered = false;

  for (const decision of decisions) {
    const traceId = event.traceId;
    const ruleId = decision.ruleId;

    try {
      await db
        .insertInto("notification_traces")
        .values({
          id: newId(),
          tenant_id: event.tenantId ?? null,
          trace_id: traceId,
          event_type: event.type,
          rule_id: ruleId,
          status: decision.status,
          reason:
            decision.status === "skipped" || decision.status === "failed"
              ? decision.reason
              : null,
          content_snapshot:
            decision.status === "sent" ? decision.content : null,
          created_at: now,
        })
        .execute();
    } catch (error) {
      logger.error({ error, traceId }, "Failed to log notification trace");
    }

    if (decision.status === "sent") {
      try {
        const adapter = adapters[decision.channel];
        if (!adapter) {
          logger.warn(
            { channel: decision.channel },
            "Channel not implemented yet",
          );
          await markTrace(traceId, ruleId, "failed", "channel_not_implemented");
          continue;
        }

        const resolvedTarget = adapter.resolvesTarget
          ? await NotificationResolver.resolve(decision.target, event)
          : decision.target;

        if (!resolvedTarget) {
          logger.error(
            { target: decision.target, ruleId },
            "Resolution failed: Unknown recipient target",
          );

          await markTrace(
            traceId,
            ruleId,
            "failed",
            "recipient_resolution_failed",
          );
          continue;
        }

        let account: ChannelAccount | null = null;
        if (adapter.needsAccount) {
          account = await accountForEvent(event);
          if (!account) {
            logger.error(
              { ruleId, tenantId: event.tenantId, eventType: event.type },
              event.tenantId
                ? "No channel account available to send notification from"
                : "Platform-wide alert has nowhere to go: set platform_ops_channel_account_id or PLATFORM_OPS_PHONE_NUMBER_ID",
            );

            await markTrace(traceId, ruleId, "failed", "no_channel_account");
            continue;
          }
        }

        // The Cloud adapter reports a failed send without throwing. A real
        // failure must mark the trace failed; nobody subscribed is a skip.
        const outcome = await adapter.send(
          account,
          resolvedTarget,
          decision.content,
          event,
        );

        if (outcome === "sent") {
          delivered = true;
          continue;
        }

        if (outcome === "no_recipient") {
          await markTrace(traceId, ruleId, "skipped", "no_recipient");
          continue;
        }

        logger.error(
          {
            ruleId,
            traceId,
            channelAccountId: account?.id,
            channelAccountStatus: account?.status,
          },
          "Notification was not delivered",
        );

        await markTrace(traceId, ruleId, "failed", "send_failed");
      } catch (error: any) {
        logger.error(
          { error, traceId, ruleId },
          "Failed to dispatch notification",
        );

        await markTrace(
          traceId,
          ruleId,
          "failed",
          error?.message ?? "unknown_error",
        );
      }
    }
  }

  return delivered;
}

async function markTrace(
  traceId: string,
  ruleId: string,
  status: "skipped" | "failed",
  reason: string,
): Promise<void> {
  try {
    await withoutTenantScope("a trace is keyed by trace_id and rule_id")
      .updateTable("notification_traces")
      .set({ status, reason })
      .where("trace_id", "=", traceId)
      .where("rule_id", "=", ruleId)
      .execute();
  } catch {
    // Trace bookkeeping is best-effort. The delivery failure is already logged.
  }
}
