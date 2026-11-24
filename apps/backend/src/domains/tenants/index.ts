import { newId } from "@vendeya/utils";
import type {
  BusinessKind,
  Tenant,
  TenantMembership,
  TenantRole,
} from "@vendeya/types";
import type { Compilable } from "kysely";
import { batch, db, withoutTenantScope } from "../../db/index.ts";

/** Tenants have no tenant_id: a tenant row is keyed by its own id. */
const tenants = () => withoutTenantScope("tenants are keyed by id");

export const TENANT_ROLES: TenantRole[] = [
  "admin",
  "developer",
  "supervisor",
  "sales_agent",
];

const MAX_TENANT_NAME = 80;

export function isTenantRole(role: string): role is TenantRole {
  return (TENANT_ROLES as string[]).includes(role);
}

export const TenantService = {
  getAll: (): Promise<Tenant[]> =>
    tenants().selectFrom("tenants").selectAll().orderBy("name").execute(),

  getById: async (id: string): Promise<Tenant | null> =>
    (await tenants()
      .selectFrom("tenants")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? null,

  /**
   * Whether the tenant is open for access. Suspension closes a business to
   * everyone, platform operators included, and a missing tenant is closed too.
   */
  isOpen: async (id: string): Promise<boolean> =>
    (
      await tenants()
        .selectFrom("tenants")
        .select("status")
        .where("id", "=", id)
        .executeTakeFirst()
    )?.status === "active",

  /**
   * The trimmed business name, or why it is refused. Names are what people
   * see. They need not be unique: the id tells tenants apart.
   */
  checkName: (name: unknown): { name: string } | { problem: string } => {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) return { problem: "name is required" };
    if (trimmed.length > MAX_TENANT_NAME) {
      return { problem: `name must be at most ${MAX_TENANT_NAME} characters` };
    }
    return { name: trimmed };
  },

  createStatement: (data: { id: string; name: string }): Compilable =>
    tenants()
      .insertInto("tenants")
      .values({ id: data.id, name: data.name, status: "active" }),

  create: async (data: { name: string; id?: string }): Promise<Tenant> => {
    const id = data.id ?? newId();
    await batch([TenantService.createStatement({ ...data, id })]);
    return (await TenantService.getById(id))!;
  },

  update: async (
    id: string,
    fields: { name?: string; business_kind?: BusinessKind },
  ): Promise<Tenant | null> => {
    await tenants()
      .updateTable("tenants")
      .set({ ...fields, updated_at: Date.now() })
      .where("id", "=", id)
      .execute();
    return await TenantService.getById(id);
  },

  count: async (): Promise<number> =>
    (
      await tenants()
        .selectFrom("tenants")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow()
    ).count,
};

/**
 * Clear assignments when a user's membership ends or role changes. A re-added
 * user starts clean, and another agent can take those conversations.
 */
function clearAssignments(tenantId: string, userId: string): Compilable {
  return db
    .updateTable("conversations")
    .set({ assigned_agent: null, assignment_notified_at: null })
    .where("tenant_id", "=", tenantId)
    .where("assigned_agent", "=", userId);
}

/** A user's memberships span tenants: the account is global. */
const acrossTenants = () =>
  withoutTenantScope("a user's own memberships, keyed by user id");

export const MembershipService = {
  /** Open tenants the user belongs to, with the role they hold in each. */
  listForUser: (
    userId: string,
  ): Promise<Array<Tenant & { role: TenantRole }>> =>
    acrossTenants()
      .selectFrom("tenant_memberships as m")
      .innerJoin("tenants as t", "t.id", "m.tenant_id")
      .selectAll("t")
      .select("m.role")
      .where("m.user_id", "=", userId)
      .where("t.status", "=", "active")
      .orderBy("t.name")
      .execute(),

  /**
   * How many tenants a user belongs to, counting suspended ones. Callers use it
   * where a change to the global user record would reach beyond the acting
   * tenant. A suspended tenant still counts because it can be reactivated.
   */
  countForUser: async (userId: string): Promise<number> =>
    (
      await acrossTenants()
        .selectFrom("tenant_memberships")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow()
    ).count,

  listForTenant: (tenantId: string): Promise<TenantMembership[]> =>
    db
      .selectFrom("tenant_memberships")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .orderBy("created_at")
      .execute(),

  get: async (
    tenantId: string,
    userId: string,
  ): Promise<TenantMembership | null> =>
    (await db
      .selectFrom("tenant_memberships")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("user_id", "=", userId)
      .executeTakeFirst()) ?? null,

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
  }): Compilable[] {
    return [
      db
        .updateTable("conversations")
        .set({ assigned_agent: null, assignment_notified_at: null })
        .where("tenant_id", "=", data.tenantId)
        .where("assigned_agent", "=", data.userId)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom("tenant_memberships")
              .select("id")
              .where("tenant_id", "=", data.tenantId)
              .where("user_id", "=", data.userId)
              .where("role", "!=", data.role),
          ),
        ),
      db
        .insertInto("tenant_memberships")
        .values({
          id: newId(),
          tenant_id: data.tenantId,
          user_id: data.userId,
          role: data.role,
          created_by: data.createdBy ?? null,
        })
        .onConflict((oc) =>
          oc
            .columns(["tenant_id", "user_id"])
            .doUpdateSet((eb) => ({ role: eb.ref("excluded.role") })),
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
    const changed = await db
      .updateTable("tenant_memberships")
      .set({ is_available: isAvailable ? 1 : 0 })
      .where("tenant_id", "=", tenantId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return changed.numUpdatedRows > 0n;
  },

  /**
   * Clear every assignment a user holds, in every tenant. A deactivated account
   * cannot work its conversations, and the scope hides them from the other
   * agents. The account is global, so the clear is too.
   */
  clearAllAssignments(userId: string): Compilable {
    return withoutTenantScope("a global account's assignments in every tenant")
      .updateTable("conversations")
      .set({ assigned_agent: null, assignment_notified_at: null })
      .where("assigned_agent", "=", userId);
  },

  removeStatements(tenantId: string, userId: string): Compilable[] {
    return [
      db
        .deleteFrom("tenant_memberships")
        .where("tenant_id", "=", tenantId)
        .where("user_id", "=", userId),
      clearAssignments(tenantId, userId),
    ];
  },

  remove: async (tenantId: string, userId: string): Promise<void> => {
    await batch(MembershipService.removeStatements(tenantId, userId));
  },
};
