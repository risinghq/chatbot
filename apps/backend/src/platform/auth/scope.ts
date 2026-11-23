import type { TenantRole } from "@vendeya/types";

/**
 * Who is asking, and in which business. A browser request acts in the business
 * it names. A token made for a business acts only there; one made without a
 * business names its business on each request. A member acts there with their
 * membership role. A platform operator belongs to no business and may act in
 * any open one.
 */
export type AuthScope = {
  userId: string;
  /**
   * The business the request acts in, or null when it names none.
   * `requireTenantScope` refuses a request with none, operator or member.
   */
  tenantId: string | null;
  /**
   * The caller's own role in `tenantId`. It is null outside a business, and for
   * an operator in a business they are not a member of. Authority comes from
   * `sessionRole`.
   */
  membershipRole: TenantRole | null;
  isPlatformOperator: boolean;
};

/** The role a platform operator is treated as holding for RBAC checks. */
const PLATFORM_OPERATOR_ROLE: TenantRole = "admin";

/**
 * The role a session acts with, as reported to the client and as checked by
 * `requireRole`. A platform operator is admin everywhere. Anyone else holds the
 * role of their membership in the request's business.
 */
export function sessionRole(session: {
  isPlatformOperator: boolean;
  membershipRole: TenantRole | null;
}): TenantRole | null {
  // An operator is admin even in a tenant where they hold a lesser membership.
  if (session.isPlatformOperator) return PLATFORM_OPERATOR_ROLE;
  // A member has no role outside a business, and never one from another.
  return session.membershipRole;
}

export function hasRole(scope: AuthScope, allowed: string[]): boolean {
  const role = sessionRole(scope);
  return role !== null && allowed.includes(role);
}

/**
 * The sales agent whose assignments bound this caller, or null when the role
 * sees the whole tenant. The agent reaches conversations assigned to them or
 * to nobody, and the orders they created or whose conversation is assigned to
 * them. An operator is admin (see `sessionRole`), so an agent membership does
 * not narrow them.
 */
export function assignedAgentScope(scope: AuthScope): string | null {
  return sessionRole(scope) === "sales_agent" ? scope.userId : null;
}

/**
 * The business a request acts in. It throws for a request that names none.
 * Request handlers reach this through `activeTenantId` in middleware/auth.ts,
 * behind `requireTenantScope`.
 */
export function writeTenantId(scope: AuthScope | null | undefined): string {
  if (!scope?.tenantId) {
    throw new TenantScopeRequiredError();
  }
  return scope.tenantId;
}

export class TenantScopeRequiredError extends Error {
  constructor() {
    super("The request must name the business it acts in");
    this.name = "TenantScopeRequiredError";
  }
}
