import { describe, expect, it } from "bun:test";
import { splitValues, variantNames } from "./business-kinds.ts";

describe("variantNames", () => {
  it("crosses two axes in order", () => {
    expect(
      variantNames([
        { name: "Talla", values: ["S", "M"] },
        { name: "Color", values: ["Rojo", "Negro"] },
      ]),
    ).toEqual(["S / Rojo", "S / Negro", "M / Rojo", "M / Negro"]);
  });

  it("skips an axis with no values", () => {
    expect(
      variantNames([
        { name: "Presentación", values: ["½ kg", "1 kg"] },
        { name: "Color", values: [" "] },
      ]),
    ).toEqual(["½ kg", "1 kg"]);
  });

  it("gives nothing when no axis has values", () => {
    expect(variantNames([{ name: "Talla", values: [] }])).toEqual([]);
  });
});

describe("splitValues", () => {
  it("trims, drops empties and repeats", () => {
    expect(splitValues(" S, M ,, M,L ")).toEqual(["S", "M", "L"]);
  });
});
