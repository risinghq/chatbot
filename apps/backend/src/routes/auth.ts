import { Hono, type Context } from "hono";
import {
  activeTenantId,
  requireActiveTenant,
  requireAuth,
  requireBrowserSession,
} from "../middleware/auth.ts";
import {
  checkTokenRequest,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../platform/auth/api-tokens.ts";
import { logAction } from "../platform/audit/logger.ts";
import { loginRateLimiter } from "../middleware/security.ts";
import { verifyPassword } from "../platform/auth/password.ts";
import { MembershipService } from "../domains/tenants/index.ts";
import { AccountService, normalizeEmail } from "../domains/accounts/index.ts";
import type { AccountError } from "../domains/accounts/errors.ts";
import { InvitationService } from "../domains/invitations/index.ts";
import {
  createSession,
  defaultTenantForUser,
  deleteSessionTokenCookie,
  generateSessionToken,
  invalidateSession,
  setSessionTokenCookie,
} from "../platform/auth/session.ts";
import { sessionRole } from "../platform/auth/scope.ts";
import { withoutTenantScope } from "../db/index.ts";

/** An account is global: a user row is keyed by its id or email, never a tenant. */
const users = () =>
  withoutTenantScope("a user account is keyed by its id or email");

/**
 * Signing up, logging in and out, and the caller's own account. Mounted at
 * /api/auth ahead of the global `requireAuth`, so each route that needs a
 * session says so.
 */
const auth = new Hono();

function accountProblem(c: Context, error: AccountError) {
  return c.json(
    { error: error.message, reason: error.reason },
    error.reason === "email_taken" ? 409 : 400,
  );
}

/**
 * Opens a session for a user who has just proved who they are, and answers
 * with the user and the open tenants they belong to. `tenantId` pins a tenant
 * the caller has already checked the user belongs to.
 */
async function startSession(c: Context, userId: string, tenantId?: string) {
  const user = await users()
    .selectFrom("users")
    .select(["id", "email", "name", "is_platform_operator"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const isPlatformOperator = user.is_platform_operator === 1;

  // A user with one open membership starts pinned to it. A platform operator,
  // and a user with several open memberships or none, starts unpinned and
  // picks a tenant via POST /api/tenants/active.
  const pinnedTenantId =
    tenantId ?? (await defaultTenantForUser(user.id, isPlatformOperator));
  const membership = pinnedTenantId
    ? await MembershipService.get(pinnedTenantId, user.id)
    : null;

  const token = generateSessionToken();
  const session = await createSession(token, user.id, pinnedTenantId);
  setSessionTokenCookie(c, token, session.expiresAt);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
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
      name: m.name,
      role: m.role,
    })),
  });
}

auth.post("/login", loginRateLimiter, async (c) => {
  const { email, password } = await c.req.json();
  const address = normalizeEmail(email);

  const user = address
    ? await users()
        .selectFrom("users")
        .select(["id", "password_hash", "is_active", "is_platform_operator"])
        .where("email", "=", address)
        .executeTakeFirst()
    : undefined;

  if (
    !user ||
    user.is_active === 0 ||
    typeof password !== "string" ||
    !(await verifyPassword(password, user.password_hash))
  ) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  // A user who is not a platform operator and belongs to no tenant has nothing
  // to log in to. Suspended tenants still count: a user whose tenants are all
  // suspended logs in unpinned, as `validateSessionToken` leaves them after a
  // suspension, so they can see they have no business to act in.
  if (
    user.is_platform_operator !== 1 &&
    (await MembershipService.countForUser(user.id)) === 0
  ) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  return startSession(c, user.id);
});

/** A new business and its first admin, logged in at once. */
auth.post("/signup", loginRateLimiter, async (c) => {
  const body = await c.req.json();
  const result = await AccountService.signUp({
    email: body.email,
    password: body.password,
    name: body.name,
    businessName: body.businessName,
  });
  if (!result.ok) return accountProblem(c, result.error);

  return startSession(c, result.value.userId);
});

/** What an invitation link offers, before anyone accepts it. */
auth.get("/invitations/:token", loginRateLimiter, async (c) => {
  const preview = await InvitationService.preview(c.req.param("token"));
  return preview
    ? c.json(preview)
    : c.json({ error: "This invitation link is not valid." }, 404);
});

/** Accepts an invitation and logs in as the invited account. */
auth.post("/invitations/:token/accept", loginRateLimiter, async (c) => {
  const body = await c.req.json();
  const result = await InvitationService.accept(c.req.param("token"), {
    name: body.name,
    password: body.password,
  });
  if (!result.ok) {
    const status = {
      not_found: 404,
      wrong_password: 401,
      inactive: 403,
    } as const;
    return c.json(
      { error: result.error.message, reason: result.error.reason },
      status[result.error.reason as keyof typeof status] ?? 400,
    );
  }

  // A person with several businesses would start unpinned, but they came for
  // this one.
  return startSession(c, result.value.userId, result.value.tenantId);
});

auth.post("/logout", requireAuth, async (c) => {
  const session = c.get("session");
  await invalidateSession(session.id);
  deleteSessionTokenCookie(c);
  return c.json({ success: true });
});

auth.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const profile = await users()
    .selectFrom("users")
    .select("phone_number")
    .where("id", "=", user.id)
    .executeTakeFirst();
  return c.json({
    user: { ...user, phoneNumber: profile?.phone_number ?? null },
  });
});

auth.patch("/me", requireAuth, async (c) => {
  const body = await c.req.json();
  const result = await AccountService.updateProfile(c.get("user").id, {
    name: body.name,
    phoneNumber: body.phoneNumber,
  });
  if (!result.ok) return accountProblem(c, result.error);
  return c.json(result.value);
});

auth.post("/me/password", requireAuth, requireBrowserSession, async (c) => {
  const body = await c.req.json();
  const result = await AccountService.changePassword(
    c.get("user").id,
    c.get("session").id,
    { current: body.currentPassword, next: body.newPassword },
  );
  if (!result.ok) return accountProblem(c, result.error);
  return c.json({ success: true });
});

auth.get("/tokens", requireAuth, async (c) => {
  return c.json(await listApiTokens(c.get("user").id));
});

/**
 * Mints a token that acts as the caller, pinned to the business the session
 * is in. The plain token is in this response and nowhere else.
 */
auth.post("/tokens", requireAuth, requireBrowserSession, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const checked = checkTokenRequest({ name: body.name, days: body.days });
  if ("problem" in checked) return c.json({ error: checked.problem }, 400);

  const user = c.get("user");
  const tenantId = c.get("session").activeTenantId;
  const created = await createApiToken(user.id, checked, tenantId);
  await logAction(
    { userId: user.id, tenantId },
    "create_api_token",
    "api_token",
    created.id,
    { name: created.name, expiresAt: created.expires_at },
  );
  return c.json(created, 201);
});

auth.delete("/tokens/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id") ?? "";
  if (!(await revokeApiToken(user.id, id))) {
    return c.json({ error: "No such token" }, 404);
  }
  await logAction(
    { userId: user.id, tenantId: c.get("session").activeTenantId },
    "revoke_api_token",
    "api_token",
    id,
  );
  return c.json({ success: true });
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
