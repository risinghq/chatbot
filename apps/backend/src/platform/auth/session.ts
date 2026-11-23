import {
  encodeBase32LowerCaseNoPadding,
  encodeHexLowerCase,
} from "@oslojs/encoding";
import { sha256 } from "@oslojs/crypto/sha2";
import type { Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { publicOrigin } from "../../config.ts";
import type { TenantMembership, TenantRole } from "@vendeya/types";
import { MembershipService } from "../../domains/tenants/index.ts";
import type { AuthScope } from "./scope.ts";
import { sessionRole } from "./scope.ts";
import { withoutTenantScope } from "../../db/index.ts";

/** A browser drops a Secure cookie that an http origin sets. */
function cookieSecure(): boolean {
  return publicOrigin().startsWith("https:");
}

/**
 * A browser login rides the `session` cookie. A token is a program's
 * credential, sent as `Authorization: Bearer`. Each is refused on the other's
 * transport, so a stolen cookie value is no bearer token and the reverse.
 */
export type SessionKind = "browser" | "token";

export interface Session {
  id: string;
  kind: SessionKind;
  userId: string;
  activeTenantId: string | null;
  expiresAt: Date;
}

export interface User {
  id: string;
  email: string;
  /**
   * The role the session acts with, from `sessionRole`. A platform operator is
   * admin in every scope. Anyone else has their membership role in the active
   * tenant, or null while no tenant is selected.
   */
  role: string | null;
  name: string;
  isPlatformOperator: boolean;
  activeTenantId: string | null;
  /**
   * Whether the agent is taking new conversations in the active tenant. It
   * comes from the membership there, so it is false while no tenant is
   * selected and for an operator who is not a member of the pinned tenant.
   */
  isAvailable: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    user: User;
    session: Session;
    scope: AuthScope;
  }
}

/**
 * `fresh` is true when this call pushed the session's expiry out. The browser
 * still holds the cookie with the old expiry, so the caller must send it again.
 */
export type SessionValidationResult =
  | { session: Session; user: User; scope: AuthScope; fresh: boolean }
  | { session: null; user: null; scope: null; fresh: false };

/** A session is global: one is keyed by its token's hash or by its user's id. */
const sessions = () =>
  withoutTenantScope("a session is keyed by its token hash or a user id");

export function generateSessionToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const token = encodeBase32LowerCaseNoPadding(bytes);
  return token;
}

/** A session's id is the hash of its token, so the table holds no credential. */
export function sessionIdOf(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

/**
 * Picks the tenant a fresh session starts in. A user with exactly one open
 * membership starts in it. Everyone else starts unpinned. A platform operator
 * chooses explicitly, and a user with several memberships is not put in
 * whichever tenant sorted first.
 */
export async function defaultTenantForUser(
  userId: string,
  isPlatformOperator: boolean,
): Promise<string | null> {
  if (isPlatformOperator) return null;

  const memberships = await MembershipService.listForUser(userId);
  return memberships.length === 1 ? memberships[0]!.id : null;
}

export async function createSession(
  token: string,
  userId: string,
  activeTenantId: string | null = null,
): Promise<Session> {
  const session: Session = {
    id: sessionIdOf(token),
    kind: "browser",
    userId,
    activeTenantId,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30), // 30 days
  };
  await sessions()
    .insertInto("session")
    .values({
      id: session.id,
      kind: "browser",
      name: null,
      user_id: session.userId,
      active_tenant_id: session.activeTenantId,
      expires_at: Math.floor(session.expiresAt.getTime() / 1000),
      created_at: Date.now(),
      last_used_at: null,
    })
    .execute();
  return session;
}

/**
 * Repoint a session at another tenant. The caller must already have been
 * checked against the target (membership, or platform operator).
 */
export async function setSessionTenant(
  sessionId: string,
  tenantId: string | null,
): Promise<void> {
  await sessions()
    .updateTable("session")
    .set({ active_tenant_id: tenantId })
    .where("id", "=", sessionId)
    .execute();
}

/** How stale a token's last use may get before a request records it again. */
const LAST_USED_RESOLUTION_MS = 1000 * 60 * 60;

export async function validateSessionToken(
  token: string,
  kind: SessionKind = "browser",
): Promise<SessionValidationResult> {
  const sessionId = sessionIdOf(token);
  const row = await sessions()
    .selectFrom("session as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .leftJoin("tenants as t", "t.id", "s.active_tenant_id")
    .select([
      "s.id",
      "s.kind",
      "s.user_id",
      "s.active_tenant_id",
      "s.expires_at",
      "s.last_used_at",
      "u.id as uid",
      "u.email",
      "u.name as uname",
      "u.is_platform_operator",
      "u.is_active",
      "t.status as tenant_status",
    ])
    .where("s.id", "=", sessionId)
    .executeTakeFirst();

  if (!row || row.is_active === 0 || row.kind !== kind) {
    return { session: null, user: null, scope: null, fresh: false };
  }

  const session: Session = {
    id: row.id,
    kind: row.kind,
    userId: row.user_id,
    activeTenantId: row.active_tenant_id,
    expiresAt: new Date(row.expires_at * 1000),
  };

  if (Date.now() >= session.expiresAt.getTime()) {
    await sessions()
      .deleteFrom("session")
      .where("id", "=", session.id)
      .execute();
    return { session: null, user: null, scope: null, fresh: false };
  }

  // A token keeps the expiry it was created with; only a browser session slides.
  let fresh = false;
  if (kind === "token") {
    if (Date.now() - (row.last_used_at ?? 0) >= LAST_USED_RESOLUTION_MS) {
      await sessions()
        .updateTable("session")
        .set({ last_used_at: Date.now() })
        .where("id", "=", session.id)
        .execute();
    }
  } else if (
    Date.now() >=
    session.expiresAt.getTime() - 1000 * 60 * 60 * 24 * 15
  ) {
    fresh = true;
    session.expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    await sessions()
      .updateTable("session")
      .set({ expires_at: Math.floor(session.expiresAt.getTime() / 1000) })
      .where("id", "=", session.id)
      .execute();
  }

  const isPlatformOperator = row.is_platform_operator === 1;

  // Membership and the tenant's own status are re-read on every request, so
  // revoking one or suspending the other takes effect at once.
  let membership: TenantMembership | null = null;
  if (session.activeTenantId) {
    membership = await MembershipService.get(session.activeTenantId, row.uid);

    // A suspended tenant is closed to everyone, platform operators included.
    // The pin is dropped, not the session, so the user stays logged in and can
    // select another tenant, as when a membership is revoked.
    const tenantIsOpen = row.tenant_status === "active";
    const stillAMember = membership !== null || isPlatformOperator;

    // A member whose pin is dropped has no tenant scope, so `requireTenantScope`
    // refuses them. For a platform operator no pin is the cross-tenant view, so
    // the reads exclude suspended tenants themselves (`tenantScope` in
    // db/index.ts, `canAccessTenant` in auth/scope.ts). POST /api/tenants/active
    // refuses a suspended tenant.
    if (!tenantIsOpen || !stillAMember) {
      await setSessionTenant(session.id, null);
      session.activeTenantId = null;
      membership = null;
    }
  }

  const membershipRole: TenantRole | null = membership?.role ?? null;

  const scope: AuthScope = {
    userId: row.uid,
    tenantId: session.activeTenantId,
    membershipRole,
    isPlatformOperator,
  };

  const user: User = {
    id: row.uid,
    email: row.email,
    role: sessionRole({ isPlatformOperator, membershipRole }),
    name: row.uname,
    isPlatformOperator,
    activeTenantId: session.activeTenantId,
    isAvailable: membership?.is_available === 1,
  };

  return { session, user, scope, fresh };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await sessions().deleteFrom("session").where("id", "=", sessionId).execute();
}

export function setSessionTokenCookie(
  c: Context,
  token: string,
  expiresAt: Date,
): void {
  setCookie(c, "session", token, {
    httpOnly: true,
    sameSite: "Lax",
    expires: expiresAt,
    path: "/",
    secure: cookieSecure(),
  });
}

export function deleteSessionTokenCookie(c: Context): void {
  deleteCookie(c, "session", {
    path: "/",
    secure: cookieSecure(),
  });
}
