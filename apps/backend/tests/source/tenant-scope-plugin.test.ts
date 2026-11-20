import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";
import type { Database } from "../../src/db/schema.ts";
import {
  TenantScopePlugin,
  UnscopedQueryError,
} from "../../src/db/tenant-scope.ts";

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new SqliteIntrospector(k),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
  plugins: [new TenantScopePlugin()],
});

const T = "tenant-1";

/** Kysely runs the plugin on a subquery as it is embedded, so build inside. */
function unscoped(build: () => { compile(): unknown }): string[] {
  try {
    build().compile();
    return [];
  } catch (error) {
    if (error instanceof UnscopedQueryError) return error.tables;
    throw error;
  }
}

describe("tenant scope plugin", () => {
  it("passes a tenant-scoped select", () => {
    expect(
      unscoped(() =>
        db
          .selectFrom("products")
          .selectAll()
          .where("tenant_id", "=", T)
          .where("id", "=", "p"),
      ),
    ).toEqual([]);
  });

  it("refuses a select with no tenant predicate", () => {
    expect(
      unscoped(() =>
        db.selectFrom("products").selectAll().where("id", "=", "p"),
      ),
    ).toEqual(["products"]);
  });

  it("does not count a tenant predicate inside an OR", () => {
    expect(
      unscoped(() =>
        db
          .selectFrom("products")
          .selectAll()
          .where((eb) => eb.or([eb("tenant_id", "=", T), eb("id", "=", "p")])),
      ),
    ).toEqual(["products"]);
  });

  it("ignores tables without a tenant column", () => {
    expect(
      unscoped(() => db.selectFrom("tenants").selectAll().where("id", "=", T)),
    ).toEqual([]);
  });

  it("anchors a joined table through the tenant column of a scoped one", () => {
    expect(
      unscoped(() =>
        db
          .selectFrom("product_images as i")
          .innerJoin("assets as a", (join) =>
            join
              .onRef("a.id", "=", "i.asset_id")
              .onRef("a.tenant_id", "=", "i.tenant_id"),
          )
          .select(["i.id", "a.storage_key"])
          .where("i.tenant_id", "=", T),
      ),
    ).toEqual([]);
  });

  it("refuses a joined table tied only by id", () => {
    expect(
      unscoped(() =>
        db
          .selectFrom("product_images as i")
          .innerJoin("assets as a", "a.id", "i.asset_id")
          .select(["i.id"])
          .where("i.tenant_id", "=", T),
      ),
    ).toEqual(["assets"]);
  });

  it("refuses two tables that only tie to each other", () => {
    expect(
      unscoped(() =>
        db
          .selectFrom("product_images as i")
          .innerJoin("assets as a", (join) =>
            join
              .onRef("a.id", "=", "i.asset_id")
              .onRef("a.tenant_id", "=", "i.tenant_id"),
          )
          .select(["i.id"]),
      ),
    ).toEqual(["assets", "product_images"]);
  });

  it("checks a subquery on its own", () => {
    expect(
      unscoped(() =>
        db
          .selectFrom("products")
          .select("id")
          .where("tenant_id", "=", T)
          .where(
            "id",
            "in",
            db.selectFrom("product_variants").select("product_id"),
          ),
      ),
    ).toEqual(["product_variants"]);
  });

  it("anchors a correlated subquery through the outer table", () => {
    expect(
      unscoped(() =>
        db
          .selectFrom("products as p")
          .select((eb) => [
            "p.id",
            eb
              .selectFrom("product_variants as v")
              .select(eb.fn.countAll().as("n"))
              .whereRef("v.product_id", "=", "p.id")
              .whereRef("v.tenant_id", "=", "p.tenant_id")
              .as("variants"),
          ])
          .where("p.tenant_id", "=", T),
      ),
    ).toEqual([]);
  });

  it("accepts a tenant_id IN subquery for a cross-tenant read", () => {
    expect(
      unscoped(() =>
        db
          .selectFrom("outbox")
          .selectAll()
          .where(
            "tenant_id",
            "in",
            db
              .selectFrom("tenants")
              .select("id")
              .where("status", "=", "active"),
          ),
      ),
    ).toEqual([]);
  });

  it("checks updates and deletes", () => {
    expect(
      unscoped(() =>
        db.updateTable("products").set({ name: "x" }).where("id", "=", "p"),
      ),
    ).toEqual(["products"]);
    expect(
      unscoped(() =>
        db
          .updateTable("products")
          .set({ name: "x" })
          .where("tenant_id", "=", T)
          .where("id", "=", "p"),
      ),
    ).toEqual([]);
    expect(
      unscoped(() => db.deleteFrom("product_images").where("id", "=", "i")),
    ).toEqual(["product_images"]);
  });

  it("checks the select of an INSERT ... SELECT, not a plain insert", () => {
    expect(
      unscoped(() =>
        db.insertInto("product_images").values({
          id: "i",
          tenant_id: T,
          product_id: "p",
          asset_id: "a",
          position: 0,
        }),
      ),
    ).toEqual([]);
    expect(
      unscoped(() =>
        db
          .insertInto("product_images")
          .columns(["id", "tenant_id", "product_id", "asset_id", "position"])
          .expression(
            db
              .selectFrom("product_images")
              .select([
                sql.lit("i").as("id"),
                sql.lit(T).as("tenant_id"),
                sql.lit("p").as("product_id"),
                sql.lit("a").as("asset_id"),
                sql<number>`coalesce(max(position) + 1, 0)`.as("position"),
              ])
              .where("product_id", "=", "p"),
          ),
      ),
    ).toEqual(["product_images"]);
  });

  it("skips the check without the plugin", () => {
    expect(
      unscoped(() => db.withoutPlugins().selectFrom("products").selectAll()),
    ).toEqual([]);
  });
});
