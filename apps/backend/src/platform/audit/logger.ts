import { newId } from "@vendeya/utils";
import { tenantOrPlatformPredicate } from "../../db/query.ts";
import type { AuditLog } from "@vendeya/types";
import { type Binding, getAll, stmt } from "../../db/index.ts";

/**
 * Who did it and inside which tenant. `tenantId` is null only for actions taken
 * outside any tenant, such as a platform operator editing global settings.
 */
export type AuditActor = {
  userId: string;
  tenantId: string | null;
};

/**
 * Who ran a command in a terminal. The environment can change `name` but not
 * `uid`, so a row records both.
 */
export type CliOperator = {
  name: string;
  uid: number;
};

/**
 * What a reader shows for an audit row. `resolvedName` is the name the reader
 * looked up for `user_id`, and it is absent for a terminal command, a missing
 * user or an empty name. The stored `actor` (`user:<id>` or `cli:<name>`) covers
 * those.
 */
export function auditActorLabel(
  resolvedName: string | null | undefined,
  actor: string,
): string {
  return resolvedName || actor;
}

function insert(
  actor: string,
  userId: string | null,
  tenantId: string | null,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, any>,
): D1PreparedStatement {
  return stmt(
    `INSERT INTO audit_log (id, tenant_id, user_id, actor, action, resource_type, resource_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      tenantId,
      userId,
      actor,
      action,
      resourceType,
      resourceId,
      JSON.stringify(metadata),
    ],
  );
}

/** The audit row for a dashboard action, for a caller that batches it with the change. */
export function auditStatement(
  actor: AuditActor,
  action: string,
  resourceType: string,
  resourceId: string | null = null,
  metadata: Record<string, any> = {},
): D1PreparedStatement {
  return insert(
    `user:${actor.userId}`,
    actor.userId,
    actor.tenantId,
    action,
    resourceType,
    resourceId,
    metadata,
  );
}

/** The audit row for a terminal command, for a caller that batches it with the change. */
export function cliAuditStatement(
  operator: CliOperator,
  tenantId: string | null,
  action: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, any> = {},
): D1PreparedStatement {
  return insert(
    `cli:${operator.name}`,
    null,
    tenantId,
    action,
    resourceType,
    resourceId,
    { ...metadata, uid: operator.uid },
  );
}

export async function logAction(
  actor: AuditActor,
  action: string,
  resourceType: string,
  resourceId: string | null = null,
  metadata: Record<string, any> = {},
): Promise<void> {
  await auditStatement(actor, action, resourceType, resourceId, metadata).run();
}

/**
 * `tenantId` null returns the entries of every open tenant and the platform's
 * own rows. The audit route passes null only for an unpinned platform operator.
 * A tenant-scoped caller sees their own tenant's entries.
 */
export async function getAuditTrail(
  tenantId: string | null,
  userId?: string,
  limit: number = 100,
): Promise<AuditLog[]> {
  const conditions: string[] = [];
  const params: Binding[] = [];

  conditions.push(tenantOrPlatformPredicate(tenantId));
  if (tenantId) params.push(tenantId);
  if (userId) {
    conditions.push("user_id = ?");
    params.push(userId);
  }

  params.push(limit);

  return getAll<AuditLog>(
    `SELECT * FROM audit_log
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`,
    params,
  );
}
