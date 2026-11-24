import { describe, expect, it } from "bun:test";
import { acceptsFile } from "./accept";

describe("acceptsFile", () => {
  it("matches extensions, MIME types and wildcards", () => {
    const sheet = ".csv,.xlsx, .xls";
    expect(acceptsFile(sheet, { name: "Productos.XLSX", type: "" })).toBe(true);
    expect(acceptsFile(sheet, { name: "foto.png", type: "image/png" })).toBe(
      false,
    );
    expect(
      acceptsFile("image/*", { name: "foto.png", type: "image/png" }),
    ).toBe(true);
    expect(acceptsFile("image/*", { name: "a.csv", type: "text/csv" })).toBe(
      false,
    );
    expect(acceptsFile("text/csv", { name: "a", type: "text/csv" })).toBe(true);
  });
});
