import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateSchema, SCHEMA_FILE } from "../../scripts/db-types.ts";

describe("db schema types", () => {
  it("match the migrations", () => {
    expect(
      readFileSync(SCHEMA_FILE, "utf-8") === generateSchema()
        ? ""
        : "src/db/schema.ts is stale: run `bun run db:types` in apps/backend.",
    ).toBe("");
  });
});
