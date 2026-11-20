import {
  encodeBase32LowerCaseNoPadding,
  encodeHexLowerCase,
} from "@oslojs/encoding";
import { sha256 } from "@oslojs/crypto/sha2";
import type { TenantRole } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { batch, getAll, getOne, run, stmt } from "../../db/index.ts";
import { hashPassword, verifyPassword } from "../../platform/auth/password.ts";
import { auditStatement } from "../../platform/audit/logger.ts";
import { Err, Ok, type Result } from "../../shared/result/index.ts";
import {
  MIN_PASSWORD_LENGTH,
  meetsPasswordMinimum,
  normalizeEmail,
  normalizeName,
} from "../accounts/index.ts";
import { MembershipService, isTenantRole } from "../tenants/index.ts";

const INVITATION_LIFETIME_MS = 1000 * 60 * 60 * 24 * 7;

export type InvitationProblem =
  | "invalid_email"
  | "invalid_role"
  | "already_member"
  | "not_found"
  | "invalid_name"
  | "password_too_short"
  | "wrong_password"
  | "inactive";

export class InvitationError extends Error {
  constructor(
    public readonly reason: InvitationProblem,
    message: string,
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

export type PendingInvitation = {
  id: string;
  email: string;
  role: TenantRole;
  expires_at: number;
  created_at: number;
};

/** What the person holding the link sees before accepting. */
export type InvitationPreview = {
  tenantName: string;
  email: string;
  role: TenantRole;
  /** Whether the email already has an account, so the page asks for its password. */
  hasAccount: boolean;
};

/**
 * Only the hash is stored. A leaked table cannot be turned into working links.
 */
function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

function newToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return encodeBase32LowerCaseNoPadding(bytes);
}

type OpenInvitation = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  email: string;
  role: TenantRole;
};

/** An invitation that can still be accepted: not used, not expired, tenant open. */
async function findOpen(token: unknown): Promise<OpenInvitation | null> {
  if (typeof token !== "string" || !token) return null;
  return (
    (await getOne<OpenInvitation>(
      `SELECT i.id, i.tenant_id, t.name as tenant_name, i.email, i.role
       FROM invitations i
       JOIN tenants t ON t.id = i.tenant_id
       WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?
         AND t.status = 'active'`,
      [hashToken(token), Date.now()],
    )) ?? null
  );
}

const notFound = () =>
  new InvitationError(
    "not_found",
    "This invitation link is not valid. It may have expired or been used.",
  );

/**
 * Invitations bring people into a business. An admin names an email and a
 * role and gets a link to send. Whoever opens the link proves the email is
 * theirs: with the account's password if one exists, or by choosing one.
 */
export const InvitationService = {
  /** The raw token is returned once. Only its hash is kept. */
  async create(
    tenantId: string,
    input: { email: unknown; role: unknown },
    createdBy: string,
  ): Promise<Result<{ id: string; token: string }, InvitationError>> {
    const email = normalizeEmail(input.email);
    if (!email) {
      return Err(
        new InvitationError("invalid_email", "That is not an email address."),
      );
    }
    if (typeof input.role !== "string" || !isTenantRole(input.role)) {
      return Err(new InvitationError("invalid_role", "Choose a valid role."));
    }

    const member = await getOne(
      `SELECT 1 FROM tenant_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = ? AND u.email = ?`,
      [tenantId, email],
    );
    if (member) {
      return Err(
        new InvitationError(
          "already_member",
          "That person is already a member of this business.",
        ),
      );
    }

    const id = newId();
    const token = newToken();

    // A new invitation for the same email replaces any pending one, so only
    // the latest link works.
    await batch([
      stmt(
        "DELETE FROM invitations WHERE tenant_id = ? AND email = ? AND accepted_at IS NULL",
        [tenantId, email],
      ),
      stmt(
        `INSERT INTO invitations (id, tenant_id, email, role, token_hash, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          email,
          input.role,
          hashToken(token),
          Date.now() + INVITATION_LIFETIME_MS,
          createdBy,
        ],
      ),
      auditStatement(
        { userId: createdBy, tenantId },
        "create_invitation",
        "invitation",
        id,
        {
          email,
          role: input.role,
        },
      ),
    ]);

    return Ok({ id, token });
  },

  listPending: (tenantId: string): Promise<PendingInvitation[]> =>
    getAll<PendingInvitation>(
      `SELECT id, email, role, expires_at, created_at FROM invitations
       WHERE tenant_id = ? AND accepted_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
      [tenantId, Date.now()],
    ),

  /** False when the tenant has no such pending invitation. */
  async revoke(
    tenantId: string,
    id: string,
    revokedBy: string,
  ): Promise<boolean> {
    const pending = await getOne(
      "SELECT 1 FROM invitations WHERE id = ? AND tenant_id = ? AND accepted_at IS NULL",
      [id, tenantId],
    );
    if (!pending) return false;

    await batch([
      stmt("DELETE FROM invitations WHERE id = ?", [id]),
      auditStatement(
        { userId: revokedBy, tenantId },
        "revoke_invitation",
        "invitation",
        id,
      ),
    ]);
    return true;
  },

  async preview(token: unknown): Promise<InvitationPreview | null> {
    const invitation = await findOpen(token);
    if (!invitation) return null;

    const account = await getOne("SELECT 1 FROM users WHERE email = ?", [
      invitation.email,
    ]);
    return {
      tenantName: invitation.tenant_name,
      email: invitation.email,
      role: invitation.role,
      hasAccount: Boolean(account),
    };
  },

  /**
   * Joins the invited email to the business. An existing account proves itself
   * with its password. Otherwise the account is created with the name and
   * password given. Returns the user id and the tenant joined.
   */
  async accept(
    token: unknown,
    input: { name: unknown; password: unknown },
  ): Promise<Result<{ userId: string; tenantId: string }, InvitationError>> {
    const invitation = await findOpen(token);
    if (!invitation) return Err(notFound());

    const account = await getOne<{
      id: string;
      password_hash: string;
      is_active: number;
    }>("SELECT id, password_hash, is_active FROM users WHERE email = ?", [
      invitation.email,
    ]);

    let userId: string;
    const writes: D1PreparedStatement[] = [];

    if (account) {
      if (account.is_active !== 1) {
        return Err(
          new InvitationError("inactive", "That account is disabled."),
        );
      }
      if (
        typeof input.password !== "string" ||
        !(await verifyPassword(input.password, account.password_hash))
      ) {
        return Err(
          new InvitationError("wrong_password", "The password is wrong."),
        );
      }
      userId = account.id;
    } else {
      const name = normalizeName(input.name);
      if (!name) {
        return Err(
          new InvitationError("invalid_name", "Your name is required."),
        );
      }
      if (!meetsPasswordMinimum(input.password)) {
        return Err(
          new InvitationError(
            "password_too_short",
            `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
          ),
        );
      }
      userId = newId();
      writes.push(
        stmt(
          `INSERT INTO users (id, email, password_hash, name, created_by)
           VALUES (?, ?, ?, ?, NULL)`,
          [userId, invitation.email, await hashPassword(input.password), name],
        ),
      );
    }

    await batch([
      ...writes,
      ...MembershipService.upsertStatements({
        tenantId: invitation.tenant_id,
        userId,
        role: invitation.role,
        createdBy: userId,
      }),
      stmt(
        "UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ?",
        [Date.now(), userId, invitation.id],
      ),
      auditStatement(
        { userId, tenantId: invitation.tenant_id },
        "accept_invitation",
        "invitation",
        invitation.id,
        { role: invitation.role },
      ),
    ]);

    return Ok({ userId, tenantId: invitation.tenant_id });
  },

  /** Expired invitations nobody accepted. The hourly sweep calls it. */
  purgeExpired: async (now: number): Promise<void> => {
    await run(
      "DELETE FROM invitations WHERE accepted_at IS NULL AND expires_at <= ?",
      [now],
    );
  },
};
