import { describe, expect, it } from "bun:test";
import { BUSINESS_KIND_PROFILES } from "./business-kinds";
import { importTemplate } from "./import-template";

const lines = (text: string) => text.replace(/^﻿/, "").trimEnd().split("\r\n");

describe("importTemplate", () => {
  it("gives a clothing shop size and colour columns with example rows", () => {
    const text = importTemplate(BUSINESS_KIND_PROFILES.clothing);
    expect(text.startsWith("﻿")).toBe(true);
    expect(lines(text)).toEqual([
      "Producto,Categoría,Talla,Color,SKU,Precio,Costo,Stock,Descripción",
      "Polo básico de algodón,Polos,S,Rojo,,49.90,30.00,10,",
      "Polo básico de algodón,Polos,M,Rojo,,49.90,30.00,10,",
      "Polo básico de algodón,Polos,L,Rojo,,49.90,30.00,10,",
    ]);
  });

  it("gives an electronics shop brand and model, and quotes a cell with a quote", () => {
    const [header, row, ...rest] = lines(
      importTemplate(BUSINESS_KIND_PROFILES.electronics),
    );
    expect(header).toBe(
      "Producto,Categoría,Capacidad,Color,SKU,Precio,Costo,Stock,Marca,Modelo,Descripción",
    );
    expect(row).toBe(
      '"Televisor Smart 55"" 4K",Televisores,128 GB,Negro,,49.90,30.00,10,,,',
    );
    expect(rest).toEqual([]);
  });

  it("leaves an axis blank when the kind has no example for it", () => {
    const [header, row] = lines(importTemplate(BUSINESS_KIND_PROFILES.beauty));
    expect(header!.split(",").slice(2, 4)).toEqual(["Tamaño", "Tono"]);
    expect(row!.split(",").slice(2, 4)).toEqual(["50 ml", ""]);
  });
});
