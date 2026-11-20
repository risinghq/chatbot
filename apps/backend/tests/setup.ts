import {
  abortAllDurableObjects,
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import { initializeApplication } from "../src/bootstrap/index.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

/** The pool loads the Worker's entry, which wires the same subscribers. */
initializeApplication();

/** The schema as the migrations leave it; null until this file builds it. */
let builtSchema: string | null = null;
let tables: string[] = [];

/**
 * Every test starts with the migrated schema, no rows, empty KV and R2, and
 * no live Durable Object, so no test sees another's rows, breaker state or
 * lock. The pool gives each file its own storage, so the schema is built once
 * per file and only rows are cleared between tests: replaying the migrations
 * cost about 120 ms a test. A test that drops a table or adds a trigger
 * changes the schema, and the next test rebuilds it.
 */
beforeEach(async () => {
  if ((await currentSchema()) !== builtSchema) {
    await rebuild();
    return;
  }
  await abortAllDurableObjects();
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = on"),
    ...tables.map((name) => env.DB.prepare(`DELETE FROM "${name}"`)),
  ]);
  await Promise.all([clearKv(), clearFiles()]);
});

/** Drops what the migrations made, then replays them. */
async function rebuild() {
  await abortAllDurableObjects();
  const { results: objects } = await env.DB.prepare(
    `SELECT type, name FROM sqlite_master
       WHERE type IN ('table', 'view', 'trigger')
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
       ORDER BY type = 'table', rowid DESC`,
  ).all<{ type: string; name: string }>();
  if (objects.length > 0) {
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = on"),
      ...objects.map(({ type, name }) =>
        env.DB.prepare(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`),
      ),
    ]);
  }
  await Promise.all([clearKv(), clearFiles()]);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  builtSchema = await currentSchema();
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
       AND name <> 'd1_migrations'`,
  ).all<{ name: string }>();
  tables = results.map((row) => row.name);
}

async function currentSchema(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT group_concat(type || ':' || name || ':' || ifnull(sql, ''), char(10)) AS schema FROM (SELECT * FROM sqlite_master ORDER BY type, name)",
  ).first<{ schema: string | null }>();
  return row?.schema ?? "";
}

async function clearKv() {
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ cursor });
    await Promise.all(page.keys.map((key) => env.KV.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function clearFiles() {
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ cursor });
    if (page.objects.length > 0) {
      await env.FILES.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
