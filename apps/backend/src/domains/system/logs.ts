import { db, tenantScope } from "../../db/index.ts";
import { auditActorLabel } from "../../platform/audit/logger.ts";
import type { SystemLogEntry, SystemLogStatus } from "@vendeya/types";

export const SystemLogService = {
  async getRecentLogs(
    tenantId: string,
    limit: number = 100,
  ): Promise<SystemLogEntry[]> {
    const llmCalls = await db
      .selectFrom("llm_calls")
      .select([
        "id",
        "created_at",
        "operation",
        "status",
        "phone_number",
        "latency_ms",
        "prompt",
        "response",
        "error_message",
        "context_metadata",
      ])
      .where(tenantScope(tenantId))
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();

    const auditRows = await db
      .selectFrom("audit_log as a")
      .leftJoin("users as u", (join) => join.onRef("a.user_id", "=", "u.id"))
      .select([
        "a.id",
        "a.created_at",
        "a.action",
        "a.resource_type",
        "a.resource_id",
        "a.metadata",
        "u.name as actor_name",
        "a.user_id",
        "a.actor",
      ])
      .where("a.tenant_id", "=", tenantId)
      .orderBy("a.created_at", "desc")
      .limit(limit)
      .execute();

    const normalized: SystemLogEntry[] = [
      ...llmCalls.map((c) => ({
        id: c.id,
        timestamp: c.created_at as unknown as string,
        source: "llm" as const,
        event: c.operation,
        status: (c.status as SystemLogStatus) || "info",
        actor: c.phone_number,
        summary: (c.status === "error"
          ? c.error_message
          : `${c.latency_ms}ms latency`) as string,
        metadata: c.context_metadata ? JSON.parse(c.context_metadata) : {},
        original_data: c,
      })),
      ...auditRows.map((a) => ({
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
