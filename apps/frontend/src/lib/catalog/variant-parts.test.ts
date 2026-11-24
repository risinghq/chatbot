import { describe, expect, it } from "bun:test";
import { hasPart, sharedParts } from "./variant-parts.ts";

describe("sharedParts", () => {
  it("gives the values that pick out a group, in first-seen order", () => {
    expect(
      sharedParts(["S / Rojo", "S / Negro", "M / Rojo", "M / Negro"]),
    ).toEqual(["S", "Rojo", "Negro", "M"]);
  });

  it("leaves out a value every variant or only one variant has", () => {
    expect(sharedParts(["M / Rojo", "M / Negro", "M / Azul"])).toEqual([]);
  });

  it("gives nothing for unnamed or single-value variants", () => {
    expect(sharedParts([null, "1 kg", "½ kg"])).toEqual([]);
  });
});

describe("hasPart", () => {
  it("matches a whole option value, not a substring", () => {
    expect(hasPart("M / Rojo", "Rojo")).toBe(true);
    expect(hasPart("M / Rojo oscuro", "Rojo")).toBe(false);
  });
});
