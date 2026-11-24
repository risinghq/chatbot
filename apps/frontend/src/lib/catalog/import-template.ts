import type { BusinessKindProfile } from "./business-kinds";

const EXAMPLE_ROWS = 3;

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The spreadsheet an owner fills to import a catalog: the columns the import
 * reads, with one column per way the kind varies, and example rows in the
 * kind's words. An axis with no usual values takes its part of the kind's
 * variant example, "M / Rojo". The leading BOM makes Excel read it as UTF-8.
 */
export function importTemplate(profile: BusinessKindProfile): string {
  const exampleParts = profile.variantExample.split(" / ");
  const axes = profile.axes.map((axis, i) => ({
    name: axis.name,
    values:
      axis.values.length > 0
        ? axis.values
        : exampleParts[i]
          ? [exampleParts[i]]
          : [""],
  }));
  const combos = axes
    .reduce<string[][]>(
      (rows, axis) =>
        rows.flatMap((row) => axis.values.map((value) => [...row, value])),
      [[]],
    )
    .slice(0, EXAMPLE_ROWS);

  const header = [
    "Producto",
    "Categoría",
    ...axes.map((axis) => axis.name),
    "SKU",
    "Precio",
    "Costo",
    "Stock",
    ...(profile.hasModel ? ["Marca", "Modelo"] : []),
    "Descripción",
  ];
  const rows = combos.map((values) => [
    profile.productExample,
    profile.categoryExample,
    ...values,
    "",
    "49.90",
    "30.00",
    "10",
    ...(profile.hasModel ? ["", ""] : []),
    "",
  ]);
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
