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
 * A cross-tenant read of tenant rows spans only active tenants. See
 * `openTenantsOnly` in db/query.ts for why the exclusion lives in the read.
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

/** What D1 binds. `undefined` is bound as NULL, as an absent optional field means. */
export type Binding = string | number | boolean | null | undefined;

export type RunResult = { changes: number; lastInsertRowid: number };

/**
 * One prepared statement, for `batch`. Every read and write of the application
 * goes through the binding named `DB` in wrangler.jsonc.
 */
export function stmt(sql: string, params: Binding[] = []): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...params.map((value) => value ?? null));
}

/** A query that matches no row gives `undefined`. */
export async function getOne<T>(
  sql: string,
  params: Binding[] = [],
): Promise<T | undefined> {
  return (await stmt(sql, params).first<T>()) ?? undefined;
}

export async function getAll<T>(
  sql: string,
  params: Binding[] = [],
): Promise<T[]> {
  return (await stmt(sql, params).all<T>()).results;
}

export async function run(
  sql: string,
  params: Binding[] = [],
): Promise<RunResult> {
  return resultOf(await stmt(sql, params).run());
}

/**
 * D1 has no interactive transaction. A batch runs its statements in order as
 * one transaction: all of them apply or none does. A step that depends on an
 * earlier statement's result reads it inside SQL (a subquery or `changes()`),
 * since no code runs between the statements. A Kysely query compiles here, so
 * the tenant check runs on it too.
 */
export async function batch(
  statements: (D1PreparedStatement | Compilable)[],
): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  return env.DB.batch(
    statements.map((statement) =>
      "compile" in statement
        ? d1Statement(env.DB, statement.compile())
        : statement,
    ),
  );
}

function resultOf(result: D1Result): RunResult {
  return {
    changes: result.meta.changes,
    lastInsertRowid: result.meta.last_row_id,
  };
}
