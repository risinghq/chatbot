/**
 * Queries on the shared `db` run side by side. A query D1 has not answered
 * holds nothing another query waits on: a lock shared across requests fails
 * in workerd once the request that made it ends.
 */

import { env } from "cloudflare:workers";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "../src/db/index.ts";

const DB = env.DB;

afterEach(() => {
  env.DB = DB;
});

describe("D1Dialect", () => {
  it("runs a query while another still waits on D1", async () => {
    let calls = 0;
    env.DB = {
      prepare: (query: string) => {
        calls += 1;
        const stalled = calls === 1;
        return {
          bind: () => ({
            all: () =>
              stalled ? new Promise(() => {}) : DB.prepare(query).all(),
          }),
        };
      },
    } as unknown as D1Database;

    void sql`select 1 as up`.execute(db);
    const second = await sql<{ up: number }>`select 2 as up`.execute(db);

    expect(second.rows).toEqual([{ up: 2 }]);
  });
});
