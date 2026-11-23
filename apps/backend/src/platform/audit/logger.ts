import { newId } from "@vendeya/utils";
import type { Compilable } from "kysely";
import type { AuditLog } from "@vendeya/types";
import { batch, db } from "../../db/index.ts";

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
): Compilable {
  return db.insertInto("audit_log").values({
    id: newId(),
    tenant_id: tenantId,
    user_id: userId,
    actor,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    metadata: JSON.stringify(metadata),
  });
}

/** The audit row for a dashboard action, for a caller that batches it with the change. */
export function auditStatement(
  actor: AuditActor,
  action: string,
  resourceType: string,
  resourceId: string | null = null,
  metadata: Record<string, any> = {},
): Compilable {
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
): Compilable {
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
  await batch([
    auditStatement(actor, action, resourceType, resourceId, metadata),
  ]);
}

/** The entries of one business, newest first. */
export async function getAuditTrail(
  tenantId: string,
  userId?: string,
  limit: number = 100,
): Promise<AuditLog[]> {
  return (await db
    .selectFrom("audit_log")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .$if(Boolean(userId), (q) => q.where("user_id", "=", userId!))
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute()) as AuditLog[];
}
