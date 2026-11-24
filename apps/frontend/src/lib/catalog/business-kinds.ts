import type { BusinessKind } from "@vendeya/types";

/** One way a product varies, such as size, with the values a shop usually offers. */
export type VariantAxis = { name: string; values: string[] };

/**
 * How the catalog forms speak to a kind of business. A clothing shop sells
 * sizes and colours; a TV has a model and maybe a capacity; food is sold by
 * presentation, since an order counts whole units.
 */
export type BusinessKindProfile = {
  label: string;
  examples: string;
  productExample: string;
  categoryExample: string;
  /** Whether a product has a model number worth asking for. */
  hasModel: boolean;
  variantExample: string;
  axes: VariantAxis[];
  /** Said under the variant list, when the kind needs a hint. */
  variantHint?: string;
};

const WHOLE_UNITS =
  "Un pedido cuenta unidades enteras. Para vender medio kilo o por metro, crea una variante por cantidad y dale su precio.";

export const BUSINESS_KIND_PROFILES: Record<BusinessKind, BusinessKindProfile> =
  {
    clothing: {
      label: "Ropa y calzado",
      examples: "Polos, vestidos, zapatillas",
      productExample: "Polo básico de algodón",
      categoryExample: "Polos",
      hasModel: false,
      variantExample: "M / Rojo",
      axes: [
        { name: "Talla", values: ["S", "M", "L", "XL"] },
        { name: "Color", values: [] },
      ],
    },
    electronics: {
      label: "Electrónica y electrodomésticos",
      examples: "Televisores, celulares, refrigeradoras",
      productExample: 'Televisor Smart 55" 4K',
      categoryExample: "Televisores",
      hasModel: true,
      variantExample: "128 GB / Negro",
      axes: [
        { name: "Capacidad", values: [] },
        { name: "Color", values: [] },
      ],
    },
    food: {
      label: "Comida y bebidas",
      examples: "Abarrotes, quesos, postres",
      productExample: "Queso fresco de Cajamarca",
      categoryExample: "Lácteos",
      hasModel: false,
      variantExample: "½ kg",
      axes: [{ name: "Presentación", values: ["½ kg", "1 kg"] }],
      variantHint: WHOLE_UNITS,
    },
    hardware: {
      label: "Ferretería y construcción",
      examples: "Herramientas, cables, pintura",
      productExample: "Cable THW 14 AWG",
      categoryExample: "Electricidad",
      hasModel: true,
      variantExample: "Rollo de 100 m",
      axes: [{ name: "Medida", values: ["1 m", "10 m", "Rollo de 100 m"] }],
      variantHint: WHOLE_UNITS,
    },
    beauty: {
      label: "Belleza y cuidado personal",
      examples: "Perfumes, cremas, maquillaje",
      productExample: "Crema hidratante facial",
      categoryExample: "Cuidado de la piel",
      hasModel: false,
      variantExample: "50 ml",
      axes: [
        { name: "Tamaño", values: ["50 ml", "100 ml"] },
        { name: "Tono", values: [] },
      ],
    },
    other: {
      label: "Otro",
      examples: "Cualquier otro producto",
      productExample: "Nombre del producto",
      categoryExample: "Categoría",
      hasModel: true,
      variantExample: "Grande",
      axes: [{ name: "Opción", values: [] }],
    },
  };

/** The profile of a business that has not said what it sells is the general one. */
export function businessKindProfile(
  kind: BusinessKind | null | undefined,
): BusinessKindProfile {
  return BUSINESS_KIND_PROFILES[kind ?? "other"];
}

/**
 * Every combination of the axes' values as a variant name, "M / Rojo". An
 * axis with no values is skipped, so one filled axis gives a plain list.
 */
export function variantNames(axes: VariantAxis[]): string[] {
  return axes
    .map((axis) => axis.values.map((v) => v.trim()).filter(Boolean))
    .filter((values) => values.length > 0)
    .reduce<string[]>(
      (names, values) =>
        names.length === 0
          ? [...values]
          : names.flatMap((name) => values.map((v) => `${name} / ${v}`)),
      [],
    );
}

/** The values typed in one field, split on commas. */
export function splitValues(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}
