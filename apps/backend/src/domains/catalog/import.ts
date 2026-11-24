import { parseCents } from "@vendeya/types";
import { newId } from "@vendeya/utils";
import type { Compilable } from "kysely";
import * as XLSX from "xlsx";
import { batch, db, tenantScope } from "../../db/index.ts";
import { isConstraintError } from "../../db/constraints.ts";
import { openingStockStatements } from "../stock/index.ts";
import { DuplicateSkuError } from "./variants.ts";

/** Rows past this go in another file: each row costs a D1 query or a share of one. */
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** A new product with no category lands here. */
export const DEFAULT_CATEGORY = "General";

type Field =
  | "product"
  | "category"
  | "variant"
  | "sku"
  | "price"
  | "cost"
  | "stock"
  | "brand"
  | "model"
  | "description";

/** Header spellings, compared without case, accents, spaces or punctuation. */
const HEADERS: Record<string, Field> = {
  producto: "product",
  nombre: "product",
  nombredelproducto: "product",
  product: "product",
  name: "product",
  categoria: "category",
  category: "category",
  variante: "variant",
  variant: "variant",
  sku: "sku",
  codigo: "sku",
  cod: "sku",
  precio: "price",
  precioventa: "price",
  preciodeventa: "price",
  price: "price",
  costo: "cost",
  preciocompra: "cost",
  preciodecompra: "cost",
  cost: "cost",
  stock: "stock",
  cantidad: "stock",
  unidades: "stock",
  inventario: "stock",
  marca: "brand",
  brand: "brand",
  modelo: "model",
  model: "model",
  descripcion: "description",
  description: "description",
};

/**
 * Columns that each hold one option, in sheet order. "Talla" and "Color"
 * make the variant "M / Rojo", the name the variant grid gives.
 */
const OPTION_HEADERS = new Set([
  "talla",
  "color",
  "tamano",
  "medida",
  "presentacion",
  "capacidad",
  "tono",
  "sabor",
  "opcion",
]);

export type ImportRow = {
  /** The row number the owner sees in the spreadsheet. */
  row: number;
  product: string;
  category: string | null;
  variant: string | null;
  sku: string | null;
  price_cents: number;
  cost_cents: number | null;
  stock: number;
  brand: string | null;
  model: string | null;
  description: string | null;
};

export type RowError = { row: number; message: string };

export type ParsedSheet = {
  rows: ImportRow[];
  errors: RowError[];
  ignored_columns: string[];
};

/** A file the import cannot read at all, with the reason for the owner. */
export class UnreadableSheetError extends Error {}

function headerKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** Cents from a cell: 49.9, "49,90", "S/ 1,299.00". Null when it is not money. */
export function cellCents(value: unknown): number | null {
  if (typeof value === "number") {
    const cents = Math.round(value * 100);
    return value >= 0 && Math.abs(cents - value * 100) < 1e-6 ? cents : null;
  }
  let text = cellText(value)
    .replace(/^s\/\.?/i, "")
    .replace(/\s/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(text))
    text = text.replace(/,/g, "");
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text))
    text = text.replace(/\./g, "");
  return parseCents(text);
}

function cellCount(value: unknown): number | null {
  const text = cellText(value);
  if (text === "") return 0;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * The first sheet of an xlsx, xls or CSV file as rows of cells. A CSV is
 * decoded as UTF-8 here, since SheetJS reads raw bytes as Latin-1 and would
 * garble "Categoría". Its cells stay text: SheetJS would read "18,50" as
 * 1850, and `cellCents` knows the comma decimal.
 */
export function readSheet(bytes: Uint8Array): unknown[][] {
  const isWorkbook =
    (bytes[0] === 0x50 && bytes[1] === 0x4b) || // xlsx is a zip
    (bytes[0] === 0xd0 && bytes[1] === 0xcf); // xls is an OLE file
  let workbook: XLSX.WorkBook;
  try {
    workbook = isWorkbook
      ? XLSX.read(bytes, { type: "array" })
      : XLSX.read(new TextDecoder().decode(bytes), {
          type: "string",
          raw: true,
        });
  } catch {
    throw new UnreadableSheetError(
      "No se pudo leer el archivo. Sube un Excel (.xlsx) o un CSV.",
    );
  }
  const name = workbook.SheetNames[0];
  const sheet = name ? workbook.Sheets[name] : undefined;
  if (!sheet) throw new UnreadableSheetError("El archivo no tiene hojas.");
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: null,
  });
}

/** The rows of a sheet whose first row names the columns. */
export function parseSheet(table: unknown[][]): ParsedSheet {
  const [header = [], ...body] = table;
  const columns = new Map<Field, number>();
  const options: number[] = [];
  const ignored: string[] = [];
  header.forEach((cell, index) => {
    const label = cellText(cell);
    if (label === "") return;
    const key = headerKey(label);
    const field = HEADERS[key];
    if (field && !columns.has(field)) columns.set(field, index);
    else if (OPTION_HEADERS.has(key)) options.push(index);
    else ignored.push(label);
  });
  if (!columns.has("product") || !columns.has("price")) {
    throw new UnreadableSheetError(
      "La primera fila debe nombrar las columnas, al menos Producto y Precio.",
    );
  }
  if (body.length > MAX_IMPORT_ROWS) {
    throw new UnreadableSheetError(
      `El archivo tiene ${body.length} filas; sube hasta ${MAX_IMPORT_ROWS} por vez.`,
    );
  }

  const rows: ImportRow[] = [];
  const errors: RowError[] = [];
  body.forEach((cells, index) => {
    const row = index + 2;
    const get = (field: Field) => {
      const at = columns.get(field);
      return at === undefined ? null : cells[at];
    };
    const text = (field: Field) => cellText(get(field)) || null;
    if (cells.every((cell) => cellText(cell) === "")) return;

    const product = text("product");
    if (!product) {
      errors.push({ row, message: "Falta el nombre del producto" });
      return;
    }
    const price = cellCents(get("price"));
    if (price === null) {
      errors.push({ row, message: "El precio no es un monto, como 49.90" });
      return;
    }
    const costCell = get("cost");
    const cost = cellText(costCell) === "" ? null : cellCents(costCell);
    if (cellText(costCell) !== "" && cost === null) {
      errors.push({ row, message: "El costo no es un monto, como 30.00" });
      return;
    }
    const stock = cellCount(get("stock"));
    if (stock === null) {
      errors.push({ row, message: "El stock debe ser un número entero" });
      return;
    }
    const optionValues = options
      .map((at) => cellText(cells[at]))
      .filter(Boolean);
    const variant =
      text("variant") ??
      (optionValues.length > 0 ? optionValues.join(" / ") : null);

    rows.push({
      row,
      product,
      category: text("category"),
      variant,
      sku: text("sku"),
      price_cents: price,
      cost_cents: cost,
      stock,
      brand: text("brand"),
      model: text("model"),
      description: text("description"),
    });
  });
  return { rows, errors, ignored_columns: ignored };
}

type NewProduct = {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  description: string | null;
};

type NewVariant = {
  id: string;
  row: number;
  product_id: string;
  name: string | null;
  sku: string;
  price_cents: number;
  cost_cents: number | null;
  stock: number;
};

type VariantUpdate = {
  id: string;
  row: number;
  price_cents: number;
  cost_cents: number | null;
};

export type ImportPlan = {
  products: NewProduct[];
  variants: NewVariant[];
  updates: VariantUpdate[];
  errors: RowError[];
};

export type ImportSummary = {
  new_products: number;
  new_variants: number;
  updated_variants: number;
  units: number;
};

export function summarize(plan: ImportPlan): ImportSummary {
  return {
    new_products: plan.products.length,
    new_variants: plan.variants.length,
    updated_variants: plan.updates.length,
    units: plan.variants.reduce((sum, v) => sum + v.stock, 0),
  };
}

const sameName = (name: string | null) => (name ?? "").trim().toLowerCase();

const IN_CHUNK = 90;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * What the rows would do to the catalog. A row whose SKU exists updates
 * that variant's price, and its cost when the row gives one, so a sheet of
 * prices keeps the costs on file. A row without a SKU updates the variant of
 * the same product and name, so importing a file twice changes nothing. Any
 * other row is a new variant, of the existing product of that name or of a
 * new one. Stock is only set on new variants; an existing variant's stock
 * moves through the stock ledger.
 */
export async function planImport(
  tenantId: string,
  rows: ImportRow[],
): Promise<ImportPlan> {
  const products = await db
    .selectFrom("products")
    .select(["id", "name"])
    .where(tenantScope(tenantId))
    .execute();
  const productByName = new Map(products.map((p) => [sameName(p.name), p.id]));

  const skus = [...new Set(rows.flatMap((r) => (r.sku ? [r.sku] : [])))];
  const bySku = new Map<string, { id: string; product_id: string }>();
  for (const part of chunks(skus, IN_CHUNK)) {
    const found = await db
      .selectFrom("product_variants")
      .select(["id", "sku", "product_id"])
      .where(tenantScope(tenantId))
      .where("sku", "in", part)
      .execute();
    for (const v of found) bySku.set(v.sku, v);
  }

  const knownProducts = [
    ...new Set(
      rows.flatMap((r) => productByName.get(sameName(r.product)) ?? []),
    ),
  ];
  const byName = new Map<string, string>();
  for (const part of chunks(knownProducts, IN_CHUNK)) {
    const found = await db
      .selectFrom("product_variants")
      .select(["id", "product_id", "name"])
      .where(tenantScope(tenantId))
      .where("product_id", "in", part)
      .execute();
    for (const v of found)
      byName.set(`${v.product_id}|${sameName(v.name)}`, v.id);
  }

  const plan: ImportPlan = {
    products: [],
    variants: [],
    updates: [],
    errors: [],
  };
  const seenSkus = new Set<string>();
  const seenVariants = new Map<string, number>();
  const touched = new Set<string>();

  for (const r of rows) {
    if (r.sku) {
      if (seenSkus.has(r.sku)) {
        plan.errors.push({
          row: r.row,
          message: `El SKU ${r.sku} se repite en el archivo`,
        });
        continue;
      }
      seenSkus.add(r.sku);
    }

    let productId = productByName.get(sameName(r.product));
    const existing = r.sku
      ? bySku.get(r.sku)?.id
      : productId && byName.get(`${productId}|${sameName(r.variant)}`);
    if (existing) {
      if (touched.has(existing)) {
        plan.errors.push({
          row: r.row,
          message: "Esta variante ya está en otra fila",
        });
        continue;
      }
      touched.add(existing);
      plan.updates.push({
        id: existing,
        row: r.row,
        price_cents: r.price_cents,
        cost_cents: r.cost_cents,
      });
      continue;
    }

    if (!productId) {
      productId = newId();
      productByName.set(sameName(r.product), productId);
      plan.products.push({
        id: productId,
        name: r.product,
        category: r.category ?? DEFAULT_CATEGORY,
        brand: r.brand,
        model: r.model,
        description: r.description,
      });
    }
    const key = `${productId}|${sameName(r.variant)}`;
    const earlier = seenVariants.get(key);
    if (earlier !== undefined) {
      plan.errors.push({
        row: r.row,
        message: `Repite la variante de la fila ${earlier}; ponle otro nombre o un SKU`,
      });
      continue;
    }
    seenVariants.set(key, r.row);
    const id = newId();
    plan.variants.push({
      id,
      row: r.row,
      product_id: productId,
      name: r.variant,
      sku: r.sku ?? id.slice(-8).toUpperCase(),
      price_cents: r.price_cents,
      cost_cents: r.cost_cents,
      stock: r.stock,
    });
  }
  return plan;
}

/** D1 binds at most 100 values to one statement. */
const MAX_BOUND = 99;

/**
 * Writes the plan in one D1 batch, which commits or rolls back as a whole.
 * `locationId` receives the opening stock; it is required when a new variant
 * has stock. Throws `DuplicateSkuError` when another write took a SKU since
 * the plan was made.
 */
export async function applyImport(
  tenantId: string,
  plan: ImportPlan,
  locationId: string | null,
  createdBy: string | null,
): Promise<void> {
  const statements: Compilable[] = [];
  for (const part of chunks(plan.products, Math.floor(MAX_BOUND / 7))) {
    statements.push(
      db
        .insertInto("products")
        .values(part.map((p) => ({ ...p, tenant_id: tenantId }))),
    );
  }
  for (const part of chunks(plan.variants, Math.floor(MAX_BOUND / 7))) {
    statements.push(
      db.insertInto("product_variants").values(
        part.map(({ stock: _, row: __, ...v }) => ({
          ...v,
          tenant_id: tenantId,
        })),
      ),
    );
  }
  for (const u of plan.updates) {
    statements.push(
      db
        .updateTable("product_variants")
        .set(
          u.cost_cents === null
            ? { price_cents: u.price_cents }
            : { price_cents: u.price_cents, cost_cents: u.cost_cents },
        )
        .where("id", "=", u.id)
        .where("tenant_id", "=", tenantId),
    );
  }
  const stocked = plan.variants.filter((v) => v.stock > 0);
  if (stocked.length > 0) {
    if (!locationId) throw new Error("opening stock needs a location");
    statements.push(
      ...openingStockStatements({
        tenantId,
        locationId,
        items: stocked.map((v) => ({ variantId: v.id, quantity: v.stock })),
        note: "Importado desde hoja de cálculo",
        createdBy,
      }),
    );
  }
  if (statements.length === 0) return;
  try {
    await batch(statements);
  } catch (error) {
    if (isConstraintError(error, "UNIQUE")) throw new DuplicateSkuError("");
    throw error;
  }
}
