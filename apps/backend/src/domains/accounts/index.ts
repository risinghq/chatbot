import { MIN_PASSWORD_LENGTH } from "@vendeya/types";
import { batch, getOne, stmt } from "../../db/index.ts";
import { hashPassword } from "../../platform/auth/password.ts";
import {
  type CliOperator,
  cliAuditStatement,
} from "../../platform/audit/logger.ts";
import { Err, Ok, type Result } from "../../shared/result/index.ts";
import { MembershipService, TenantService } from "../tenants/index.ts";

import {
  AccountError,
  type CreatedAccount,
  type NewAccount,
  type PromotedAccount,
} from "./errors.ts";

export { MIN_PASSWORD_LENGTH };

type UserRow = {
  id: string;
  username: string;
  name: string;
  is_platform_operator: number;
  is_active: number;
};

const USER_COLUMNS =
  "id, username, name, is_platform_operator, COALESCE(is_active, 1) AS is_active";

async function listTenants(): Promise<string> {
  return (await TenantService.getAll())
    .map((tenant) => `${tenant.id} (${tenant.slug})`)
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
        "This database has no tenant to add the account to. Run `bun run seed` or `bun run account tenant create` to create one, or create a platform operator.",
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

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/.test(error.message)
  );
}

/**
 * Account creation and promotion for the operator command. Each change writes
 * its audit row in the same batch, naming the operator who ran the command.
 * Promoting an existing operator writes no row.
 */
export const AccountService = {
  /** Everything `create` refuses except the password, so a caller can ask first. */
  async checkNew(
    input: NewAccount,
  ): Promise<Result<string | null, AccountError>> {
    if (input.username === "" || input.username !== input.username.trim()) {
      return Err(
        new AccountError(
          "invalid_username",
          "The username must not be empty or start or end with whitespace.",
        ),
      );
    }

    const tenantId = await resolveTenant(input);
    if (!tenantId.ok) return tenantId;

    const taken = await getOne<{ id: string }>(
      "SELECT id FROM users WHERE username = ?",
      [input.username],
    );

    return taken
      ? Err(new AccountError("username_taken", "That username is taken."))
      : tenantId;
  },

  /** A disabled operator does not count: nobody can use their powers. */
  async hasPlatformOperator(): Promise<boolean> {
    return Boolean(
      await getOne(
        `SELECT 1 FROM users
         WHERE is_platform_operator = 1 AND COALESCE(is_active, 1) = 1
         LIMIT 1`,
      ),
    );
  },

  /** A platform operator gets no membership. Anyone else administers one tenant. */
  async create(
    input: NewAccount & { password: string },
    operator: CliOperator,
  ): Promise<Result<CreatedAccount, AccountError>> {
    if (input.password.length < MIN_PASSWORD_LENGTH) {
      return Err(
        new AccountError(
          "password_too_short",
          `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        ),
      );
    }

    const tenantId = await AccountService.checkNew(input);
    if (!tenantId.ok) return tenantId;

    const id = crypto.randomUUID();
    const name = input.name?.trim() || input.username;
    const isOperator = tenantId.value === null;

    try {
      await batch([
        stmt(
          `INSERT INTO users (id, username, password_hash, role, name, is_platform_operator, created_by)
           VALUES (?, ?, ?, 'admin', ?, ?, NULL)`,
          [
            id,
            input.username,
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
          username: input.username,
          ...(!isOperator && { role: "admin" }),
          platformOperator: isOperator,
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return Err(
          new AccountError("username_taken", "That username is taken."),
        );
      }
      throw error;
    }

    return Ok({
      id,
      username: input.username,
      name,
      isPlatformOperator: isOperator,
      tenant:
        tenantId.value === null
          ? null
          : {
              id: tenantId.value,
              slug: (await TenantService.getById(tenantId.value))!.slug,
            },
    });
  },

  /** Memberships are kept. The cross-tenant powers are added to them. */
  async promote(
    username: string,
    operator: CliOperator,
  ): Promise<Result<PromotedAccount, AccountError>> {
    const account = await getOne<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE username = ?`,
      [username],
    );

    if (!account) {
      return Err(
        new AccountError("not_found", "No account has that username."),
      );
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
          crypto.randomUUID(),
          `cli:${operator.name}`,
          account.id,
          JSON.stringify({
            username: account.username,
            platformOperator: true,
            uid: operator.uid,
          }),
        ],
      ),
    ]);
    const changed = (promoted?.meta.changes ?? 0) > 0;

    return Ok({ id: account.id, username: account.username, changed });
  },
};
