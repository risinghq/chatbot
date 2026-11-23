/**
 * Raw D1 access for fixture setup and assertions. A fixture statement names the
 * table it checks, bypassing the application's query layer on purpose; the
 * tenant-scope plugin only covers queries built with `db`.
 */
import { env } from "cloudflare:workers";
import type { Compilable } from "kysely";
import { d1Statement } from "../../src/db/d1-dialect.ts";

export { db } from "../../src/db/index.ts";

export type Binding = string | number | boolean | null | undefined;

export type RunResult = { changes: number; lastInsertRowid: number };

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
  const result = await stmt(sql, params).run();
  return {
    changes: result.meta.changes,
    lastInsertRowid: result.meta.last_row_id,
  };
}

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
