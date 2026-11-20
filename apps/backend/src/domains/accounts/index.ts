import { MIN_PASSWORD_LENGTH } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import { batch, getOne, stmt } from "../../db/index.ts";
import { hashPassword, verifyPassword } from "../../platform/auth/password.ts";
import {
  type CliOperator,
  auditStatement,
  cliAuditStatement,
} from "../../platform/audit/logger.ts";
import { Err, Ok, type Result } from "../../shared/result/index.ts";
import { MembershipService, TenantService } from "../tenants/index.ts";

import {
  AccountError,
  type CreatedAccount,
  type NewAccount,
  type PromotedAccount,
  type SignUp,
} from "./errors.ts";

export { MIN_PASSWORD_LENGTH };

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 80;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The email as it is stored: trimmed and lower-cased, or null when it is not
 * an address. The column compares without case as well, so an address typed
 * in capitals still finds its account.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(email)
    ? email
    : null;
}

/** A trimmed display name, or null when it is empty or too long. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

export function meetsPasswordMinimum(password: unknown): password is string {
  return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

const invalidEmail = () =>
  new AccountError("invalid_email", "That is not an email address.");
const emailTaken = () =>
  new AccountError("email_taken", "An account already uses that email.");
const passwordTooShort = () =>
  new AccountError(
    "password_too_short",
    `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  );

type UserRow = {
  id: string;
  email: string;
  name: string;
  is_platform_operator: number;
  is_active: number;
};

async function listTenants(): Promise<string> {
  return (await TenantService.getAll())
    .map((tenant) => `${tenant.id} (${tenant.name})`)
    .join(", ");
}

/** The tenant id a new account joins, or null for a platform operator. */
async function resolveTenant(
  input: NewAccount,
): Promise<Result<string | null, AccountError>> {
  if (input.platformOperator) {
    return input.tenantId === undefined
      ? Ok(null)
      : Err(
          new AccountError(
            "conflicting_scope",
            "A platform operator belongs to no tenant, so a tenant cannot be given as well.",
          ),
        );
  }

  if (input.tenantId !== undefined) {
    return (await TenantService.getById(input.tenantId))
      ? Ok(input.tenantId)
      : Err(
          new AccountError(
            "unknown_tenant",
            `No tenant has that id. Tenants: ${(await listTenants()) || "none"}.`,
          ),
        );
  }

  const all = await TenantService.getAll();

  if (all.length === 0) {
    return Err(
      new AccountError(
        "no_tenant",
        "This database has no tenant to add the account to. Create one with `bun run account tenant create --name <business name>`, or create a platform operator.",
      ),
    );
  }

  if (all.length > 1) {
    return Err(
      new AccountError(
        "tenant_required",
        `This database has ${all.length} tenants, so one must be named. Tenants: ${await listTenants()}.`,
      ),
    );
  }

  return Ok(all[0]!.id);
}

async function emailIsTaken(email: string): Promise<boolean> {
  return Boolean(await getOne("SELECT 1 FROM users WHERE email = ?", [email]));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/.test(error.message)
  );
}

/**
 * Creating, promoting and changing accounts. Each change writes its audit row
 * in the same batch. Promoting an existing operator writes no row.
 */
export const AccountService = {
  /** Everything `create` refuses except the password, so a caller can ask first. */
  async checkNew(
    input: NewAccount,
  ): Promise<Result<string | null, AccountError>> {
    const email = normalizeEmail(input.email);
    if (!email) return Err(invalidEmail());

    const tenantId = await resolveTenant(input);
    if (!tenantId.ok) return tenantId;

    return (await emailIsTaken(email)) ? Err(emailTaken()) : tenantId;
  },

  /** A disabled operator does not count: nobody can use their powers. */
  async hasPlatformOperator(): Promise<boolean> {
    return Boolean(
      await getOne(
        `SELECT 1 FROM users
         WHERE is_platform_operator = 1 AND is_active = 1
         LIMIT 1`,
      ),
    );
  },

  /**
   * An account made from a terminal. A platform operator gets no membership.
   * Anyone else administers one tenant.
   */
  async create(
    input: NewAccount & { password: string },
    operator: CliOperator,
  ): Promise<Result<CreatedAccount, AccountError>> {
    if (!meetsPasswordMinimum(input.password)) return Err(passwordTooShort());

    const tenantId = await AccountService.checkNew(input);
    if (!tenantId.ok) return tenantId;

    const id = newId();
    const email = normalizeEmail(input.email)!;
    const name = normalizeName(input.name) ?? email;
    const isOperator = tenantId.value === null;

    try {
      await batch([
        stmt(
          `INSERT INTO users (id, email, password_hash, name, is_platform_operator, created_by)
           VALUES (?, ?, ?, ?, ?, NULL)`,
          [
            id,
            email,
            await hashPassword(input.password),
            name,
            isOperator ? 1 : 0,
          ],
        ),
        ...(tenantId.value === null
          ? []
          : MembershipService.upsertStatements({
              tenantId: tenantId.value,
              userId: id,
              role: "admin",
              createdBy: null,
            })),
        cliAuditStatement(operator, tenantId.value, "create_user", "user", id, {
          email,
          ...(!isOperator && { role: "admin" }),
          platformOperator: isOperator,
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return Err(emailTaken());
      throw error;
    }

    const tenant =
      tenantId.value === null
        ? null
        : await TenantService.getById(tenantId.value);

    return Ok({
      id,
      email,
      name,
      isPlatformOperator: isOperator,
      tenant: tenant ? { id: tenant.id, name: tenant.name } : null,
    });
  },

  /**
   * A new business and the person who opens it, as its admin. The user,
   * tenant, membership and audit row are written in one batch, so a refused
   * write leaves nothing behind.
   */
  async signUp(
    input: SignUp,
  ): Promise<Result<{ userId: string; tenantId: string }, AccountError>> {
    const email = normalizeEmail(input.email);
    if (!email) return Err(invalidEmail());

    const name = normalizeName(input.name);
    if (!name) {
      return Err(new AccountError("invalid_name", "Your name is required."));
    }

    const business = TenantService.checkName(input.businessName);
    if ("problem" in business) {
      return Err(
        new AccountError("invalid_name", "The business name is required."),
      );
    }

    if (!meetsPasswordMinimum(input.password)) return Err(passwordTooShort());
    if (await emailIsTaken(email)) return Err(emailTaken());

    const userId = newId();
    const tenantId = newId();

    try {
      await batch([
        stmt(
          `INSERT INTO users (id, email, password_hash, name)
           VALUES (?, ?, ?, ?)`,
          [userId, email, await hashPassword(input.password), name],
        ),
        TenantService.createStatement({ id: tenantId, name: business.name }),
        ...MembershipService.upsertStatements({
          tenantId,
          userId,
          role: "admin",
          createdBy: userId,
        }),
        auditStatement({ userId, tenantId }, "sign_up", "tenant", tenantId, {
          email,
          name: business.name,
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return Err(emailTaken());
      throw error;
    }

    return Ok({ userId, tenantId });
  },

  /** The caller's own name and phone number. */
  async updateProfile(
    userId: string,
    input: { name: unknown; phoneNumber: unknown },
  ): Promise<
    Result<{ name: string; phoneNumber: string | null }, AccountError>
  > {
    const name = normalizeName(input.name);
    if (!name) {
      return Err(new AccountError("invalid_name", "Your name is required."));
    }
    const phoneNumber =
      typeof input.phoneNumber === "string" && input.phoneNumber.trim()
        ? input.phoneNumber.trim()
        : null;

    await batch([
      stmt("UPDATE users SET name = ?, phone_number = ? WHERE id = ?", [
        name,
        phoneNumber,
        userId,
      ]),
      auditStatement(
        { userId, tenantId: null },
        "update_profile",
        "user",
        userId,
      ),
    ]);

    return Ok({ name, phoneNumber });
  },

  /**
   * The caller's own password, checked against the current one. Every other
   * session ends, so a stolen session dies with the old password.
   */
  async changePassword(
    userId: string,
    sessionId: string,
    input: { current: unknown; next: unknown },
  ): Promise<Result<void, AccountError>> {
    const row = await getOne<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = ?",
      [userId],
    );
    if (!row) return Err(new AccountError("not_found", "No such account."));

    if (
      typeof input.current !== "string" ||
      !(await verifyPassword(input.current, row.password_hash))
    ) {
      return Err(
        new AccountError("wrong_password", "The current password is wrong."),
      );
    }
    if (!meetsPasswordMinimum(input.next)) return Err(passwordTooShort());

    await batch([
      stmt("UPDATE users SET password_hash = ? WHERE id = ?", [
        await hashPassword(input.next),
        userId,
      ]),
      stmt("DELETE FROM session WHERE user_id = ? AND id != ?", [
        userId,
        sessionId,
      ]),
      auditStatement(
        { userId, tenantId: null },
        "change_password",
        "user",
        userId,
      ),
    ]);

    return Ok(undefined);
  },

  /** Memberships are kept. The cross-tenant powers are added to them. */
  async promote(
    rawEmail: string,
    operator: CliOperator,
  ): Promise<Result<PromotedAccount, AccountError>> {
    const email = normalizeEmail(rawEmail);
    if (!email) return Err(invalidEmail());

    const account = await getOne<UserRow>(
      "SELECT id, email, name, is_platform_operator, is_active FROM users WHERE email = ?",
      [email],
    );

    if (!account) {
      return Err(new AccountError("not_found", "No account has that email."));
    }

    if (account.is_active !== 1) {
      return Err(
        new AccountError(
          "inactive",
          "That account is disabled, and a disabled account cannot use the platform operator's powers.",
        ),
      );
    }

    const [promoted] = await batch([
      stmt(
        "UPDATE users SET is_platform_operator = 1 WHERE id = ? AND is_platform_operator = 0",
        [account.id],
      ),
      stmt(
        `INSERT INTO audit_log (id, tenant_id, user_id, actor, action, resource_type, resource_id, metadata)
         SELECT ?, NULL, NULL, ?, 'promote_platform_operator', 'user', ?, ?
         WHERE changes() > 0`,
        [
          newId(),
          `cli:${operator.name}`,
          account.id,
          JSON.stringify({
            email: account.email,
            platformOperator: true,
            uid: operator.uid,
          }),
        ],
      ),
    ]);
    const changed = (promoted?.meta.changes ?? 0) > 0;

    return Ok({ id: account.id, email: account.email, changed });
  },
};
