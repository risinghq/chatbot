import { env } from "cloudflare:workers";
import {
  type Compilable,
  type Expression,
  type ExpressionBuilder,
  Kysely,
  type SqlBool,
} from "kysely";
import { D1Dialect, d1Statement } from "./d1-dialect.ts";
import type { Database } from "./schema.ts";
import { TenantScopePlugin } from "./tenant-scope.ts";

/**
 * The typed query builder. Every SELECT, UPDATE and DELETE it builds must tie
 * each tenant-owned table to a tenant (db/tenant-scope.ts), or it throws
 * before reaching D1.
 */
export const db = new Kysely<Database>({
  dialect: new D1Dialect(() => env.DB),
  plugins: [new TenantScopePlugin()],
});

/**
 * The builder without the tenant check, for a read keyed by something globally
 * unique before the tenant is known: a session token, an invitation token, a
 * webhook's phone number id. `reason` names that key for the reader.
 */
export function withoutTenantScope(_reason: string): Kysely<Database> {
  return db.withoutPlugins();
}

/**
 * A cross-tenant read of tenant rows spans only active tenants. An operator's
 * session drops its pin when the tenant is suspended, but an unpinned operator
 * already reads every tenant, so the exclusion lives in the read.
 */
export function inOpenTenants(
  eb: ExpressionBuilder<Database, any>,
  column = "tenant_id",
): Expression<SqlBool> {
  return eb(
    eb.ref(column),
    "in",
    eb.selectFrom("tenants").select("id").where("status", "=", "active"),
  );
}

/**
 * The tenant predicate for a read that takes `tenantId: string | null`: a
 * concrete id reads that tenant, null reads every open tenant.
 */
export function tenantScope(tenantId: string | null, column = "tenant_id") {
  return (eb: ExpressionBuilder<Database, any>): Expression<SqlBool> =>
    tenantId ? eb(eb.ref(column), "=", tenantId) : inOpenTenants(eb, column);
}

/**
 * Accounts a background worker may send on: a send on a `pending` or
 * `disabled` number is refused, so a query that dequeues work leaves those
 * accounts out. `column` is the outer channel_account_id reference and
 * `tenantColumn` the qualified tenant_id of the same outer row, which ties
 * the account to a tenant for the scope check.
 */
export function inActiveChannelAccounts(
  eb: ExpressionBuilder<Database, any>,
  column: string,
  tenantColumn: string,
): Expression<SqlBool> {
  return eb(
    eb.ref(column),
    "in",
    eb
      .selectFrom("channel_accounts as ca")
      .select("ca.id")
      .where("ca.status", "=", "active")
      .whereRef("ca.tenant_id", "=", tenantColumn as never),
  );
}

/**
 * D1 has no interactive transaction. A batch runs its statements in order as
 * one transaction: all of them apply or none does. A step that depends on an
 * earlier statement's result reads it inside SQL (a subquery or `changes()`),
 * since no code runs between the statements. A Kysely query compiles here, so
 * the tenant check runs on it too.
 */
export async function batch(statements: Compilable[]): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  return env.DB.batch(
    statements.map((statement) => d1Statement(env.DB, statement.compile())),
  );
}
