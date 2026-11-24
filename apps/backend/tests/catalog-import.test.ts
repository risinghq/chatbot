/**
 * An owner uploads a spreadsheet of products, one row per variant. The import
 * shows what each row would do, then writes the whole file or nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import * as XLSX from "xlsx";

import { getAll, getOne } from "./helpers/db.ts";
import {
  MAX_IMPORT_ROWS,
  cellCents,
  parseSheet,
  readSheet,
  UnreadableSheetError,
} from "../src/domains/catalog/import.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import catalogRoutes from "../src/routes/catalog.ts";
import stockRoutes from "../src/routes/stock.ts";
import { createMember, insertTenant } from "./helpers/tenancy.ts";

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api/catalog", catalogRoutes);
app.route("/api/stock", stockRoutes);
app.onError(errorHandler);

const csv = (text: string) => new TextEncoder().encode(text);

function xlsx(rows: unknown[][]): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet(rows),
    "Productos",
  );
  return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
}

const POLOS = [
  ["Producto", "Categoría", "Talla", "Color", "SKU", "Precio", "Stock"],
  ["Polo básico", "Polos", "S", "Rojo", "PB-S-R", 39.9, 5],
  ["Polo básico", "Polos", "M", "Rojo", "PB-M-R", 39.9, 3],
  ["Gorra", "Accesorios", "", "", "", "25", ""],
];

describe("reading a sheet", () => {
  it("joins option columns into the variant name and reads Peruvian money", () => {
    const parsed = parseSheet(readSheet(xlsx(POLOS)));
    expect(parsed.errors).toEqual([]);
    expect(
      parsed.rows.map((r) => [
        r.row,
        r.product,
        r.variant,
        r.sku,
        r.price_cents,
        r.stock,
      ]),
    ).toEqual([
      [2, "Polo básico", "S / Rojo", "PB-S-R", 3990, 5],
      [3, "Polo básico", "M / Rojo", "PB-M-R", 3990, 3],
      [4, "Gorra", null, null, 2500, 0],
    ]);
    expect(
      [49.9, "49,90", "S/ 1,299.00", "S/. 1.299,50", "12", "-3", "abc"].map(
        cellCents,
      ),
    ).toEqual([4990, 4990, 129900, 129950, 1200, null, null]);
  });

  it("reads a UTF-8 CSV that Excel saved with semicolons", () => {
    const parsed = parseSheet(
      readSheet(
        csv(
          "NOMBRE;categoria;Presentación;Precio venta;Descripción;Notas\nQueso fresco;Lácteos;½ kg;18,50;De Cajamarca;x\n",
        ),
      ),
    );
    expect(parsed.ignored_columns).toEqual(["Notas"]);
    expect(parsed.rows).toMatchObject([
      {
        product: "Queso fresco",
        category: "Lácteos",
        variant: "½ kg",
        price_cents: 1850,
        description: "De Cajamarca",
      },
    ]);
  });

  it("names the row and the reason of each bad row", () => {
    const parsed = parseSheet(
      readSheet(
        csv(
          "Producto,Precio,Costo,Stock\n,10,,\nTaladro,diez,,\nTaladro,10,x,\nTaladro,10,,1.5\n,,,\n",
        ),
      ),
    );
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors).toEqual([
      { row: 2, message: "Falta el nombre del producto" },
      { row: 3, message: "El precio no es un monto, como 49.90" },
      { row: 4, message: "El costo no es un monto, como 30.00" },
      { row: 5, message: "El stock debe ser un número entero" },
    ]);
  });

  it("refuses a sheet without Producto and Precio, or with too many rows", () => {
    expect(() => parseSheet(readSheet(csv("Nombre,Costo\nA,1\n")))).toThrow(
      UnreadableSheetError,
    );
    const many = [
      "Producto,Precio",
      ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `P${i},1`),
    ];
    expect(() => parseSheet(readSheet(csv(many.join("\n"))))).toThrow(
      /hasta 500/,
    );
  });
});

describe("importing into a business", () => {
  let tenantId: string;
  let token: string;

  async function upload(
    path: string,
    file: Uint8Array,
    fields: Record<string, string> = {},
    as = token,
  ) {
    const form = new FormData();
    form.set("file", new File([file], "productos.xlsx"));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return await app.request(`/api/catalog/import${path}`, {
      method: "POST",
      headers: { Cookie: `session=${as}`, "X-Tenant-Id": tenantId },
      body: form,
    });
  }

  async function json<T>(response: Response, status: number): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  const variants = () =>
    getAll<{
      product: string;
      name: string | null;
      sku: string;
      price_cents: number;
      on_hand: number | null;
    }>(
      `SELECT p.name AS product, v.name, v.sku, v.price_cents, l.on_hand
         FROM product_variants v JOIN products p ON p.id = v.product_id
         LEFT JOIN stock_levels l ON l.variant_id = v.id
        WHERE v.tenant_id = ? ORDER BY p.name, v.name`,
      [tenantId],
    );

  async function login(role: "admin" | "sales_agent") {
    const { userId } = await createMember({ tenantId }, role);
    const t = generateSessionToken();
    await createSession(t, userId, tenantId);
    return t;
  }

  beforeEach(async () => {
    tenantId = await insertTenant("import");
    token = await login("admin");
  });

  it("previews without writing", async () => {
    const preview = await json<{
      summary: object;
      rows: { row: number; action: string }[];
      locations: unknown[];
    }>(await upload("/preview", xlsx(POLOS)), 200);
    expect(preview.summary).toEqual({
      new_products: 2,
      new_variants: 3,
      updated_variants: 0,
      units: 8,
    });
    expect(preview.rows.map((r) => [r.row, r.action])).toEqual([
      [2, "create"],
      [3, "create"],
      [4, "create"],
    ]);
    expect(preview.locations).toEqual([]);
    expect(await variants()).toEqual([]);
  });

  it("creates products, variants and opening stock, and a second upload changes nothing", async () => {
    expect(await json(await upload("", xlsx(POLOS)), 201)).toEqual({
      new_products: 2,
      new_variants: 3,
      updated_variants: 0,
      units: 8,
    });
    const after = await variants();
    expect(after.map(({ sku: _, ...v }) => v)).toEqual([
      { product: "Gorra", name: null, price_cents: 2500, on_hand: null },
      {
        product: "Polo básico",
        name: "M / Rojo",
        price_cents: 3990,
        on_hand: 3,
      },
      {
        product: "Polo básico",
        name: "S / Rojo",
        price_cents: 3990,
        on_hand: 5,
      },
    ]);
    expect(
      await getAll(
        "SELECT kind, quantity, note FROM stock_movements WHERE tenant_id = ? ORDER BY quantity",
        [tenantId],
      ),
    ).toEqual([
      { kind: "receive", quantity: 3, note: "Importado desde hoja de cálculo" },
      { kind: "receive", quantity: 5, note: "Importado desde hoja de cálculo" },
    ]);

    expect(await json(await upload("", xlsx(POLOS)), 201)).toEqual({
      new_products: 0,
      new_variants: 0,
      updated_variants: 3,
      units: 0,
    });
    expect(await variants()).toEqual(after);
  });

  it("updates prices by SKU and adds a variant to a product of the same name", async () => {
    await json(await upload("", xlsx(POLOS)), 201);
    const prices = xlsx([
      ["Producto", "Talla", "Color", "SKU", "Precio"],
      ["polo BÁSICO", "L", "Rojo", "", "42"],
      ["Otro nombre", "", "", "PB-S-R", "35,00"],
    ]);
    await json(await upload("", prices), 201);
    const rows = await variants();
    expect(
      rows
        .filter((v) => v.product === "Polo básico")
        .map((v) => [v.name, v.price_cents]),
    ).toEqual([
      ["L / Rojo", 4200],
      ["M / Rojo", 3990],
      ["S / Rojo", 3500],
    ]);
    expect(
      await getOne("SELECT COUNT(*) AS n FROM products WHERE tenant_id = ?", [
        tenantId,
      ]),
    ).toEqual({ n: 2 });
  });

  it("keeps the cost on file when a later sheet gives only the price", async () => {
    await json(
      await upload(
        "",
        xlsx([
          ["Producto", "SKU", "Precio", "Costo"],
          ["Taladro", "T-1", 100, 60],
        ]),
      ),
      201,
    );
    await json(
      await upload(
        "",
        xlsx([
          ["Producto", "SKU", "Precio"],
          ["Taladro", "T-1", 120],
        ]),
      ),
      201,
    );
    expect(
      await getOne(
        "SELECT price_cents, cost_cents FROM product_variants WHERE tenant_id = ?",
        [tenantId],
      ),
    ).toEqual({ price_cents: 12000, cost_cents: 6000 });
  });

  it("writes nothing when a row has an error", async () => {
    const bad = xlsx([
      ["Producto", "SKU", "Precio"],
      ["Taladro", "T-1", 100],
      ["Taladro grande", "T-1", 150],
      ["Martillo", "", "gratis"],
    ]);
    const refused = await json<{ errors: { row: number }[] }>(
      await upload("", bad),
      400,
    );
    expect(refused.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(await variants()).toEqual([]);
  });

  it("asks which location takes the stock when the business has several", async () => {
    const make = (name: string) =>
      app.request("/api/stock/locations", {
        method: "POST",
        headers: {
          Cookie: `session=${token}`,
          "X-Tenant-Id": tenantId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });
    await json(await make("Tienda"), 201);
    const second = await json<{ id: string }>(await make("Almacén"), 201);

    const preview = await json<{ locations: { id: string }[] }>(
      await upload("/preview", xlsx(POLOS)),
      200,
    );
    expect(preview.locations).toHaveLength(2);
    expect((await upload("", xlsx(POLOS))).status).toBe(400);
    await json(await upload("", xlsx(POLOS), { location_id: second.id }), 201);
    expect(
      await getAll(
        "SELECT DISTINCT location_id FROM stock_levels WHERE tenant_id = ?",
        [tenantId],
      ),
    ).toEqual([{ location_id: second.id }]);
  });

  it("handles a full file of new variants with stock in one batch", async () => {
    const rows: unknown[][] = [["Producto", "Variante", "Precio", "Stock"]];
    for (let i = 0; i < MAX_IMPORT_ROWS; i++)
      rows.push([`Producto ${i % 60}`, `V${i}`, 10 + i, 1 + (i % 4)]);
    const summary = await json<{ new_products: number; new_variants: number }>(
      await upload("", xlsx(rows)),
      201,
    );
    expect(summary).toMatchObject({
      new_products: 60,
      new_variants: MAX_IMPORT_ROWS,
    });
    expect(
      await getOne(
        "SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ?",
        [tenantId],
      ),
    ).toEqual({
      n: MAX_IMPORT_ROWS,
    });
  });

  it("is refused to a seller", async () => {
    const seller = await login("sales_agent");
    expect((await upload("/preview", xlsx(POLOS), {}, seller)).status).toBe(
      403,
    );
  });
});
