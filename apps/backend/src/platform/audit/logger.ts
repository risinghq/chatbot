import { newId } from "@vendeya/utils";
import type { Compilable } from "kysely";
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
