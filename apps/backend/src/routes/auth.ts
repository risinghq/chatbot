import { Hono } from "hono";
import {
  activeTenantId,
  requireActiveTenant,
  requireAuth,
} from "../middleware/auth.ts";
import { loginRateLimiter } from "../middleware/security.ts";
import { verifyPassword } from "../platform/auth/password.ts";
import { MembershipService } from "../domains/tenants/index.ts";
import {
  createSession,
  defaultTenantForUser,
  deleteSessionTokenCookie,
  generateSessionToken,
  invalidateSession,
  setSessionTokenCookie,
} from "../platform/auth/session.ts";
import { sessionRole } from "../platform/auth/scope.ts";
import { getOne } from "../db/index.ts";

/**
 * Logging in and out, and the caller's own account. Mounted at /api/auth ahead
 * of the global `requireAuth`, so each route that needs a session says so.
 */
const auth = new Hono();

auth.post("/login", loginRateLimiter, async (c) => {
  const { username, password } = await c.req.json();

  const user = (await getOne("SELECT * FROM users WHERE username = ?", [
    username,
  ])) as
    | {
        id: string;
        username: string;
        password_hash: string;
        role: string;
        name: string;
        is_active: number;
        is_platform_operator: number;
      }
    | undefined;

  if (!user || user.is_active === 0) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  if (
    typeof password !== "string" ||
    !(await verifyPassword(password, user.password_hash))
  ) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const isPlatformOperator = user.is_platform_operator === 1;

  // A user who is not a platform operator and belongs to no tenant has nothing
  // to log in to. Suspended tenants still count as memberships here.
  // A user whose tenants are all suspended logs in unpinned. That is the same
  // session `validateSessionToken` leaves after a tenant is suspended under a
  // logged-in user, so they can see that they have no business to act in.
  if (
    !isPlatformOperator &&
    (await MembershipService.countForUser(user.id)) === 0
  ) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  // The session carries the tenant scope it acts in. A user with one open
  // membership starts pinned to it. A platform operator, and a user with several
  // open memberships or none, starts unpinned and picks a tenant via
  // POST /api/tenants/active. Only open tenants can be pinned or picked.
  const pinnedTenantId = await defaultTenantForUser(
    user.id,
    isPlatformOperator,
  );
  const membership = pinnedTenantId
    ? await MembershipService.get(pinnedTenantId, user.id)
    : null;

  const token = generateSessionToken();
  const session = await createSession(token, user.id, pinnedTenantId);
  setSessionTokenCookie(c, token, session.expiresAt);

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      // A platform operator is admin in every scope. Anyone else holds their
      // membership role in the pinned tenant, so it is null while unpinned.
      role: sessionRole({
        isPlatformOperator,
        membershipRole: membership?.role ?? null,
      }),
      name: user.name,
      isPlatformOperator,
      activeTenantId: pinnedTenantId,
      isAvailable: membership?.is_available === 1,
    },
    tenants: (await MembershipService.listForUser(user.id)).map((m) => ({
      id: m.id,
      slug: m.slug,
      name: m.name,
      role: m.role,
    })),
  });
});

auth.post("/logout", requireAuth, async (c) => {
  const session = c.get("session");
  await invalidateSession(session.id);
  deleteSessionTokenCookie(c);
  return c.json({ success: true });
});

auth.get("/me", requireAuth, (c) => {
  const user = c.get("user");
  return c.json({ user });
});

/**
 * Take yourself in or out of the assignment rotation *of the active tenant*.
 * Availability lives on the membership, so an agent who works for two
 * businesses going offline for one stays in the other's rotation.
 */
auth.patch("/availability", requireAuth, requireActiveTenant, async (c) => {
  const user = c.get("user");
  const tenantId = activeTenantId(c);
  const { isAvailable } = await c.req.json();

  if (typeof isAvailable !== "boolean") {
    return c.json({ error: "isAvailable must be boolean" }, 400);
  }

  if (
    !(await MembershipService.setAvailability(tenantId, user.id, isAvailable))
  ) {
    // A platform operator pinned to a tenant they are not a member of has no
    // rotation to be in.
    return c.json({ error: "No membership in the active tenant" }, 404);
  }

  return c.json({ success: true, isAvailable });
});

export default auth;
