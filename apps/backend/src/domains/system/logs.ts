import { tenantOrPlatformPredicate, tenantPredicate } from "../../db/query.ts";
import type { Binding } from "../../db/index.ts";
import { auditActorLabel } from "../../platform/audit/logger.ts";
import { getAll } from "../../db/index.ts";
import type { SystemLogEntry, SystemLogStatus } from "@vendeya/types";

export const SystemLogService = {
  /**
   * A null `tenantId` spans open tenants and adds the platform's own audit
   * rows. An unpinned platform operator reaches it through
   * routes/system-logs.ts.
   */
  async getRecentLogs(
    tenantId: string | null,
    limit: number = 100,
  ): Promise<SystemLogEntry[]> {
    const llmParams: Binding[] = tenantId ? [tenantId, limit] : [limit];

    // Get LLM Calls
    const llmCalls = await getAll<any>(
      `SELECT
         id, created_at, operation, status, phone_number, latency_ms,
         prompt, response, error_message, context_metadata
       FROM llm_calls
       WHERE ${tenantPredicate(tenantId)}
       ORDER BY created_at DESC LIMIT ?`,
      llmParams,
    );

    // Get Audit Logs
    const auditLogs = await getAll<any>(
      `SELECT
         a.id, a.created_at, a.action, a.resource_type, a.resource_id, a.metadata,
         u.username as actor_name, a.user_id, a.actor
       FROM audit_log a
       LEFT JOIN users u ON a.user_id = u.id
       WHERE ${tenantOrPlatformPredicate(tenantId, "a.tenant_id")}
       ORDER BY a.created_at DESC LIMIT ?`,
      tenantId ? [tenantId, limit] : [limit],
    );

    const normalized: SystemLogEntry[] = [
      ...llmCalls.map((c) => ({
        id: c.id,
        timestamp: c.created_at,
        source: "llm" as const,
        event: c.operation,
        status: (c.status as SystemLogStatus) || "info",
        actor: c.phone_number,
        summary:
          c.status === "error" ? c.error_message : `${c.latency_ms}ms latency`,
        metadata: c.context_metadata ? JSON.parse(c.context_metadata) : {},
        original_data: c,
      })),
      ...auditLogs.map((a) => ({
        id: a.id,
        timestamp: new Date(a.created_at).toISOString(),
        source: "audit" as const,
        event: a.action,
        status: "info" as const,
        actor: auditActorLabel(a.actor_name, a.actor),
        summary: `${a.resource_type} ${a.resource_id || ""}`.trim(),
        metadata:
          a.metadata && a.metadata !== "{}" ? JSON.parse(a.metadata) : {},
        original_data: a,
      })),
    ];

    return normalized
      .sort((a, b) => {
        const dateA = new Date(a.timestamp).getTime();
        const dateB = new Date(b.timestamp).getTime();
        return dateB - dateA;
      })
      .slice(0, limit);
  },
};
