/**
 * 0003 rebuilds `channel_secrets` to admit the `app_secret` purpose, and the
 * rebuild drops the table `channel_accounts` references with ON DELETE SET
 * NULL. With foreign keys enforced, as D1 enforces them, a rebuild that loses
 * the references leaves every number without a usable credential. This file
 * applies the real migrations to an empty database with enforcement on and
 * checks the references survive.
 *
 * It reads files, not bindings, so `bun test` runs it and the Workers pool
 * leaves it out.
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");

function migration(name: string): string {
  return readFileSync(join(MIGRATIONS, name), "utf8");
}

/** An empty database at the post-0003 schema, with FK enforcement like D1. */
function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  return db;
}

/** A tenant, one secret row, and the account referencing it twice. */
function seedAccount(db: DatabaseSync): void {
  db.exec(
    "INSERT INTO tenants (id, slug, name, status) VALUES ('t', 't', 'T', 'active')",
  );
  db.exec(
    "INSERT INTO channel_secrets (id, tenant_id, purpose, ciphertext, iv, key_id) " +
      "VALUES ('s1', 't', 'access_token', 'c', 'i', 'k'), " +
      "('s2', 't', 'verify_token', 'c', 'i', 'k')",
  );
  db.exec(
    "INSERT INTO channel_accounts (id, tenant_id, phone_number_id, " +
      "access_token_secret_id, verify_token_secret_id, status) " +
      "VALUES ('ch', 't', 'pnid', 's1', 's2', 'active')",
  );
}

describe("the channel_secrets rebuild", () => {
  it("keeps the accounts' secret references", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(migration("0001_init.sql"));
    db.exec(migration("0002_tenant_secrets.sql"));
    seedAccount(db);

    db.exec(migration("0003_channel_app_secret.sql"));

    const account = db
      .prepare(
        "SELECT access_token_secret_id, verify_token_secret_id " +
          "FROM channel_accounts WHERE id = 'ch'",
      )
      .get() as {
      access_token_secret_id: string | null;
      verify_token_secret_id: string | null;
    };
    expect(account.access_token_secret_id).toBe("s1");
    expect(account.verify_token_secret_id).toBe("s2");

    db.exec(
      "INSERT INTO channel_secrets (id, tenant_id, purpose, ciphertext, iv, key_id) " +
        "VALUES ('s3', 't', 'app_secret', 'c', 'i', 'k')",
    );
  });

  it("keeps enforcement across the migration boundary", () => {
    const db = migrated();

    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_master " +
            "WHERE type = 'table' AND name = 'channel_secrets'",
        )
        .get(),
    ).toEqual({
      sql: expect.stringContaining("'app_secret'"),
    });
    expect(() =>
      db.exec(
        "INSERT INTO channel_accounts (id, tenant_id, phone_number_id, status) " +
          "VALUES ('orphan', 'no-such-tenant', 'pnid', 'active')",
      ),
    ).toThrow();
  });
});
