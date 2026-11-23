import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import {
  validateSessionToken,
  deleteSessionTokenCookie,
  setSessionTokenCookie,
} from "../platform/auth/session.ts";
import { hasRole, writeTenantId } from "../platform/auth/scope.ts";

/** Response body for a business route reached without a business. */
export const NO_ACTIVE_TENANT = {
  error: "No active tenant",
  detail: "Name the business in the X-Tenant-Id header",
} as const;

/**
 * The business a browser request acts in. A tab names it on every request, so
 * two tabs can work in two businesses. A request without it acts in none.
 */
export const TENANT_HEADER = "X-Tenant-Id";

/** The token in an `Authorization: Bearer` header, or null without one. */
function bearerToken(c: Context): string | null {
  const header = c.req.header("Authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1]! : null;
}

/**
 * Admits a browser session from the `session` cookie or an API token from an
 * `Authorization: Bearer` header. A request that sends a bearer header is
 * judged by it alone, so a program never borrows a cookie.
 */
export async function requireAuth(c: Context, next: Next) {
  const bearer = bearerToken(c);
  const token = bearer ?? getCookie(c, "session");

  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { session, user, scope, fresh, forbidden } = await validateSessionToken(
    token,
    bearer ? "token" : "browser",
    c.req.header(TENANT_HEADER) || null,
  );

  // Do not distinguish "no such business" from "not yours".
  if (forbidden) return c.json({ error: "Tenant not found" }, 404);

  if (!session || !user || !scope) {
    if (!bearer) deleteSessionTokenCookie(c);
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", user);
  c.set("session", session);
  c.set("scope", scope);

  // The browser drops the cookie at the expiry it was given at login, so a
  // renewed session needs the cookie again. Only then, not on every response.
  if (fresh) setSessionTokenCookie(c, token, session.expiresAt);

  await next();
}

/**
 * Gate for acts that only a person at a browser may take: minting tokens and
 * changing the password. A leaked token cannot extend itself or lock its
 * owner out.
 */
export async function requireBrowserSession(c: Context, next: Next) {
  if (c.get("session")?.kind !== "browser") {
    return c.json(
      { error: "This action needs a browser login, not an API token" },
      403,
    );
  }
  await next();
}

/**
 * Checks the caller's role in the active tenant. A user with no membership in
 * the active tenant has no role and fails every check. A platform operator is
 * treated as admin (see sessionRole in platform/auth/scope.ts).
 */
export function requireRole(...allowedRoles: string[]) {
  return async (c: Context, next: Next) => {
    const scope = c.get("scope");

    if (!scope || !hasRole(scope, allowedRoles)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await next();
  };
}

/**
 * Gate for routes that read or write tenant-owned data. A request that names
 * no business gets a 403, operator or member, so no handler reaches a query
 * without one.
 */
export async function requireTenantScope(c: Context, next: Next) {
  const scope = c.get("scope");

  if (!scope) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (!scope.tenantId) {
    return c.json(NO_ACTIVE_TENANT, 403);
  }

  await next();
}

/**
 * The business a request acts in. Without `requireTenantScope` in front of the
 * handler it throws TenantScopeRequiredError for a request that names none,
 * which the error handler turns into the same 403.
 */
export function activeTenantId(c: Context): string {
  return writeTenantId(c.get("scope"));
}

/** Gate for routes reserved for VendeYa's own staff. */
export async function requirePlatformOperator(c: Context, next: Next) {
  const scope = c.get("scope");

  if (!scope?.isPlatformOperator) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await next();
}
