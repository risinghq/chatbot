import { env } from "cloudflare:workers";

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
 * since no code runs between the statements.
 */
export async function batch(
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  return env.DB.batch(statements);
}

function resultOf(result: D1Result): RunResult {
  return {
    changes: result.meta.changes,
    lastInsertRowid: result.meta.last_row_id,
  };
}
