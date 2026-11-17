import type { Tenant, TenantMembership, TenantRole } from "@vendeya/types";
import { batch, getAll, getOne, run, stmt } from "../../db/index.ts";

export const TENANT_ROLES: TenantRole[] = [
  "admin",
  "developer",
  "supervisor",
  "sales_agent",
];

const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isTenantRole(role: string): role is TenantRole {
  return (TENANT_ROLES as string[]).includes(role);
}

export const TenantService = {
  getAll: (): Promise<Tenant[]> =>
    getAll<Tenant>("SELECT * FROM tenants ORDER BY name"),

  getById: async (id: string): Promise<Tenant | null> =>
    (await getOne<Tenant>("SELECT * FROM tenants WHERE id = ?", [id])) ?? null,

  getBySlug: async (slug: string): Promise<Tenant | null> =>
    (await getOne<Tenant>("SELECT * FROM tenants WHERE slug = ?", [slug])) ??
    null,

  /**
   * Whether the tenant is open for access. Suspension closes a business to
   * everyone, platform operators included, and a missing tenant is closed too.
   * `canAccessTenant` in platform/auth/scope.ts applies it to unpinned callers.
   */
  isOpen: async (id: string): Promise<boolean> =>
    (
      await getOne<{ status: string }>(
        "SELECT status FROM tenants WHERE id = ?",
        [id],
      )
    )?.status === "active",

  /** Why a new tenant cannot have this slug and name, or null when it can. */
  newTenantProblem: async (
    slug: unknown,
    name: unknown,
  ): Promise<{ taken: boolean; message: string } | null> => {
    if (
      typeof slug !== "string" ||
      typeof name !== "string" ||
      !slug ||
      !name
    ) {
      return { taken: false, message: "slug and name are required" };
    }
    if (!TENANT_SLUG.test(slug)) {
      return {
        taken: false,
        message: "slug must be lowercase alphanumeric with dashes",
      };
    }
    if (await TenantService.getBySlug(slug)) {
      return { taken: true, message: "A tenant with that slug already exists" };
    }
    return null;
  },

  createStatement: (data: {
    id: string;
    slug: string;
    name: string;
  }): D1PreparedStatement =>
    stmt(
      "INSERT INTO tenants (id, slug, name, status) VALUES (?, ?, ?, 'active')",
      [data.id, data.slug, data.name],
    ),

  create: async (data: {
    slug: string;
    name: string;
    id?: string;
  }): Promise<Tenant> => {
    const id = data.id ?? crypto.randomUUID();
    await TenantService.createStatement({ ...data, id }).run();
    return (await TenantService.getById(id))!;
  },

  count: async (): Promise<number> =>
    (await getOne<{ count: number }>("SELECT COUNT(*) as count FROM tenants"))!
      .count,
};

/**
 * Clear assignments when a user's membership ends or role changes. A re-added
 * user starts clean, and another agent can take those conversations.
 */
function clearAssignments(
  tenantId: string,
  userId: string,
): D1PreparedStatement {
  return stmt(
    `UPDATE conversations
     SET assigned_agent = NULL, assignment_notified_at = NULL
     WHERE tenant_id = ? AND assigned_agent = ?`,
    [tenantId, userId],
  );
}

export const MembershipService = {
  /** Open tenants the user belongs to, with the role they hold in each. */
  listForUser: (
    userId: string,
  ): Promise<Array<Tenant & { role: TenantRole }>> =>
    getAll<Tenant & { role: TenantRole }>(
      `SELECT t.*, m.role as role
       FROM tenant_memberships m
       JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = ? AND t.status = 'active'
       ORDER BY t.name`,
      [userId],
    ),

  /**
   * How many tenants a user belongs to, counting suspended ones. Callers use it
   * where a change to the global user record would reach beyond the acting
   * tenant. A suspended tenant still counts because it can be reactivated.
   */
  countForUser: async (userId: string): Promise<number> =>
    (await getOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM tenant_memberships WHERE user_id = ?",
      [userId],
    ))!.count,

  listForTenant: (tenantId: string): Promise<TenantMembership[]> =>
    getAll<TenantMembership>(
      "SELECT * FROM tenant_memberships WHERE tenant_id = ? ORDER BY created_at",
      [tenantId],
    ),

  get: async (
    tenantId: string,
    userId: string,
  ): Promise<TenantMembership | null> =>
    (await getOne<TenantMembership>(
      "SELECT * FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?",
      [tenantId, userId],
    )) ?? null,

  /** The role a user holds in a tenant, or null if they are not a member. */
  roleFor: async (
    tenantId: string,
    userId: string,
  ): Promise<TenantRole | null> =>
    (await MembershipService.get(tenantId, userId))?.role ?? null,

  /**
   * The statements that create or re-role a membership, for a caller that
   * writes them in its own batch. `is_available` is left alone: it is the
   * agent's own switch inside this tenant, and a role change does not reset it.
   * A role change clears the user's assignments in the tenant.
   */
  upsertStatements(data: {
    tenantId: string;
    userId: string;
    role: TenantRole;
    createdBy?: string | null;
  }): D1PreparedStatement[] {
    return [
      stmt(
        `UPDATE conversations
         SET assigned_agent = NULL, assignment_notified_at = NULL
         WHERE tenant_id = ? AND assigned_agent = ?
           AND EXISTS (
             SELECT 1 FROM tenant_memberships
             WHERE tenant_id = ? AND user_id = ? AND role != ?
           )`,
        [data.tenantId, data.userId, data.tenantId, data.userId, data.role],
      ),
      stmt(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, created_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = excluded.role`,
        [
          crypto.randomUUID(),
          data.tenantId,
          data.userId,
          data.role,
          data.createdBy ?? null,
        ],
      ),
    ];
  },

  upsert: async (data: {
    tenantId: string;
    userId: string;
    role: TenantRole;
    createdBy?: string | null;
  }): Promise<TenantMembership> => {
    await batch(MembershipService.upsertStatements(data));
    return (await MembershipService.get(data.tenantId, data.userId))!;
  },

  /**
   * Whether the agent is taking new conversations in this tenant. Availability
   * belongs to the membership, not the account: a sales agent who works for two
   * businesses can go offline for one and stay in the other's rotation. Returns
   * false when there is no membership to set it on.
   */
  setAvailability: async (
    tenantId: string,
    userId: string,
    isAvailable: boolean,
  ): Promise<boolean> => {
    const changed = await run(
      "UPDATE tenant_memberships SET is_available = ? WHERE tenant_id = ? AND user_id = ?",
      [isAvailable ? 1 : 0, tenantId, userId],
    );
    return changed.changes > 0;
  },

  /**
   * Clear every assignment a user holds, in every tenant. A deactivated account
   * cannot work its conversations, and the scope hides them from the other
   * agents. The account is global, so the clear is too.
   */
  clearAllAssignments(userId: string): D1PreparedStatement {
    return stmt(
      `UPDATE conversations
       SET assigned_agent = NULL, assignment_notified_at = NULL
       WHERE assigned_agent = ?`,
      [userId],
    );
  },

  removeStatements(tenantId: string, userId: string): D1PreparedStatement[] {
    return [
      stmt(
        "DELETE FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?",
        [tenantId, userId],
      ),
      clearAssignments(tenantId, userId),
    ];
  },

  remove: async (tenantId: string, userId: string): Promise<void> => {
    await batch(MembershipService.removeStatements(tenantId, userId));
  },
};
