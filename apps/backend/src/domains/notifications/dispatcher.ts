import { newId } from "@vendeya/utils";
import { createLogger } from "../../lib/logger.ts";
import { WhatsAppService } from "../../adapters/whatsapp/index.ts";
import { ChannelAccountService } from "../channels/accounts.ts";
import { NotificationResolver } from "./resolver.ts";
import type { NotificationDecision } from "./evaluator.ts";
import type { ChannelAccount, DomainEvent } from "@vendeya/types";
import { db, withoutTenantScope } from "../../db/index.ts";

const logger = createLogger("notification-dispatcher");

interface NotificationChannelAdapter {
  /** Whether the message actually went out. */
  send(
    account: ChannelAccount,
    target: string,
    content: string,
  ): Promise<boolean>;
}

const whatsAppAdapter: NotificationChannelAdapter = {
  async send(account: ChannelAccount, target: string, content: string) {
    if (!target) return false;
    return WhatsAppService.sendDirect(account, target, content);
  },
};

const adapters: Record<string, NotificationChannelAdapter> = {
  whatsapp: whatsAppAdapter,
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
        const resolvedTarget = await NotificationResolver.resolve(
          decision.target,
          event,
        );

        if (!resolvedTarget) {
          logger.error(
            { target: decision.target, ruleId },
            "Resolution failed: Unknown recipient target",
          );

          await markFailed(traceId, ruleId, "recipient_resolution_failed");
          continue;
        }

        const account = await accountForEvent(event);
        if (!account) {
          logger.error(
            { ruleId, tenantId: event.tenantId, eventType: event.type },
            event.tenantId
              ? "No channel account available to send notification from"
              : "Platform-wide alert has nowhere to go: set platform_ops_channel_account_id or PLATFORM_OPS_PHONE_NUMBER_ID",
          );

          await markFailed(traceId, ruleId, "no_channel_account");
          continue;
        }

        const adapter = adapters[decision.channel];
        if (!adapter) {
          logger.warn(
            { channel: decision.channel },
            "Channel not implemented yet",
          );
          await markFailed(traceId, ruleId, "channel_not_implemented");
          continue;
        }

        // The Cloud adapter answers false, without throwing, when the account
        // is not active. A false answer must mark the trace failed.
        const sent = await adapter.send(
          account,
          resolvedTarget,
          decision.content,
        );

        if (!sent) {
          logger.error(
            {
              ruleId,
              traceId,
              channelAccountId: account.id,
              channelAccountStatus: account.status,
            },
            "Notification was not delivered",
          );

          await markFailed(traceId, ruleId, "send_failed");
          continue;
        }

        delivered = true;
      } catch (error: any) {
        logger.error(
          { error, traceId, ruleId },
          "Failed to dispatch notification",
        );

        await markFailed(traceId, ruleId, error?.message ?? "unknown_error");
      }
    }
  }

  return delivered;
}

async function markFailed(
  traceId: string,
  ruleId: string,
  reason: string,
): Promise<void> {
  try {
    await withoutTenantScope("a trace is keyed by trace_id and rule_id")
      .updateTable("notification_traces")
      .set({ status: "failed", reason })
      .where("trace_id", "=", traceId)
      .where("rule_id", "=", ruleId)
      .execute();
  } catch {
    // Trace bookkeeping is best-effort. The delivery failure is already logged.
  }
}
