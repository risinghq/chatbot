import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

/**
 * A Kysely dialect over a D1 binding. D1 has no interactive transaction, so
 * `db.transaction()` throws: an atomic write is a `batch()` of statements.
 */
export class D1Dialect implements Dialect {
  constructor(private readonly database: () => D1Database) {}

  createAdapter() {
    return new D1Adapter();
  }

  createDriver(): Driver {
    return new D1Driver(this.database);
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
}

/**
 * SQLite's adapter makes Kysely queue every query behind one lock. The lock is
 * a promise held by the isolate, so a query in one request waits on a promise
 * another request made, and workerd fails it: "This promise was created by a
 * request that has since ended". A D1 binding holds no connection state, so
 * queries need no lock.
 */
class D1Adapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    return true;
  }
}

/** D1 refuses `undefined`; an absent optional value is stored as NULL. */
export function d1Statement(
  database: D1Database,
  query: Pick<CompiledQuery, "sql" | "parameters">,
): D1PreparedStatement {
  return database
    .prepare(query.sql)
    .bind(...query.parameters.map((value) => value ?? null));
}

class D1Connection implements DatabaseConnection {
  constructor(private readonly database: D1Database) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await d1Statement(this.database, compiled).all<R>();
    return {
      rows: result.results,
      numAffectedRows: BigInt(result.meta.changes ?? 0),
      insertId: result.meta.last_row_id
        ? BigInt(result.meta.last_row_id)
        : undefined,
    };
  }

  // biome-ignore lint/correctness/useYield: D1 returns whole result sets.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not stream query results.");
  }
}

class D1Driver implements Driver {
  constructor(private readonly database: () => D1Database) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1Connection(this.database());
  }

  async beginTransaction(): Promise<void> {
    throw new Error(
      "D1 has no interactive transaction. Use batch() from db/index.ts.",
    );
  }

  async commitTransaction(): Promise<void> {}

  async rollbackTransaction(): Promise<void> {}

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}
