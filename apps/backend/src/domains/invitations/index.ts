import {
  encodeBase32LowerCaseNoPadding,
  encodeHexLowerCase,
} from "@oslojs/encoding";
import { sha256 } from "@oslojs/crypto/sha2";
import type { TenantRole } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import type { Compilable } from "kysely";
import { batch, db, withoutTenantScope } from "../../db/index.ts";
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

/** An account is global: the invited email names it without a tenant. */
const accounts = () =>
  withoutTenantScope("a user account is keyed by its email");

/** An invitation that can still be accepted: not used, not expired, tenant open. */
async function findOpen(token: unknown): Promise<OpenInvitation | null> {
  if (typeof token !== "string" || !token) return null;
  return (
    (await withoutTenantScope(
      "the invitation token hash is unique and names the tenant",
    )
      .selectFrom("invitations as i")
      .innerJoin("tenants as t", "t.id", "i.tenant_id")
      .select([
        "i.id",
        "i.tenant_id",
        "t.name as tenant_name",
        "i.email",
        "i.role",
      ])
      .where("i.token_hash", "=", hashToken(token))
      .where("i.accepted_at", "is", null)
      .where("i.expires_at", ">", Date.now())
      .where("t.status", "=", "active")
      .executeTakeFirst()) ?? null
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

    const member = await db
      .selectFrom("tenant_memberships as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select("m.id")
      .where("m.tenant_id", "=", tenantId)
      .where("u.email", "=", email)
      .executeTakeFirst();
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
      db
        .deleteFrom("invitations")
        .where("tenant_id", "=", tenantId)
        .where("email", "=", email)
        .where("accepted_at", "is", null),
      db.insertInto("invitations").values({
        id,
        tenant_id: tenantId,
        email,
        role: input.role,
        token_hash: hashToken(token),
        expires_at: Date.now() + INVITATION_LIFETIME_MS,
        accepted_at: null,
        accepted_by: null,
        created_by: createdBy,
      }),
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
    db
      .selectFrom("invitations")
      .select(["id", "email", "role", "expires_at", "created_at"])
      .where("tenant_id", "=", tenantId)
      .where("accepted_at", "is", null)
      .where("expires_at", ">", Date.now())
      .orderBy("created_at", "desc")
      .execute(),

  /** False when the tenant has no such pending invitation. */
  async revoke(
    tenantId: string,
    id: string,
    revokedBy: string,
  ): Promise<boolean> {
    const pending = await db
      .selectFrom("invitations")
      .select("id")
      .where("id", "=", id)
      .where("tenant_id", "=", tenantId)
      .where("accepted_at", "is", null)
      .executeTakeFirst();
    if (!pending) return false;

    await batch([
      db
        .deleteFrom("invitations")
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId),
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

    const account = await accounts()
      .selectFrom("users")
      .select("id")
      .where("email", "=", invitation.email)
      .executeTakeFirst();
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

    const account = await accounts()
      .selectFrom("users")
      .select(["id", "password_hash", "is_active"])
      .where("email", "=", invitation.email)
      .executeTakeFirst();

    let userId: string;
    const writes: Compilable[] = [];

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
        accounts()
          .insertInto("users")
          .values({
            id: userId,
            email: invitation.email,
            password_hash: await hashPassword(input.password),
            name,
            phone_number: null,
            created_by: null,
          }),
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
      db
        .updateTable("invitations")
        .set({ accepted_at: Date.now(), accepted_by: userId })
        .where("id", "=", invitation.id)
        .where("tenant_id", "=", invitation.tenant_id),
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
    await withoutTenantScope("expired invitations in every tenant")
      .deleteFrom("invitations")
      .where("accepted_at", "is", null)
      .where("expires_at", "<=", now)
      .execute();
  },
};
