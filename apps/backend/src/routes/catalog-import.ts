import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  applyImport,
  MAX_IMPORT_BYTES,
  parseSheet,
  planImport,
  readSheet,
  summarize,
  UnreadableSheetError,
  type ImportPlan,
  type ImportRow,
  type RowError,
} from "../domains/catalog/import.ts";
import { DuplicateSkuError } from "../domains/catalog/variants.ts";
import { StockService } from "../domains/stock/index.ts";
import { activeTenantId, requireRole } from "../middleware/auth.ts";
import { logAction } from "../platform/audit/logger.ts";

const catalogImport = new Hono();

catalogImport.use(
  "/*",
  requireRole("admin", "developer", "supervisor"),
  bodyLimit({
    maxSize: MAX_IMPORT_BYTES,
    onError: (c) => c.json({ error: "El archivo pesa más de 2 MB" }, 413),
  }),
);

type Read = {
  rows: ImportRow[];
  plan: ImportPlan;
  errors: RowError[];
  ignored_columns: string[];
  locationId: string | null;
};

/** The uploaded sheet and what it would do, or the response that refuses it. */
async function readUpload(c: Context): Promise<Read | Response> {
  const tenantId = activeTenantId(c);
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) {
    return c.json({ error: "Envía el archivo en el campo file" }, 400);
  }
  let parsed: ReturnType<typeof parseSheet>;
  try {
    parsed = parseSheet(readSheet(new Uint8Array(await file.arrayBuffer())));
  } catch (error) {
    if (error instanceof UnreadableSheetError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
  const plan = await planImport(tenantId, parsed.rows);
  const errors = [...parsed.errors, ...plan.errors].sort(
    (a, b) => a.row - b.row,
  );
  const locationId =
    typeof form.location_id === "string" && form.location_id !== ""
      ? form.location_id
      : null;
  return {
    rows: parsed.rows,
    plan,
    errors,
    ignored_columns: parsed.ignored_columns,
    locationId,
  };
}

function actions(plan: ImportPlan): Map<number, "create" | "update"> {
  return new Map([
    ...plan.variants.map((v) => [v.row, "create"] as const),
    ...plan.updates.map((u) => [u.row, "update"] as const),
  ]);
}

const hasStock = (plan: ImportPlan) => plan.variants.some((v) => v.stock > 0);

/** What the file would create and update, row by row, without writing. */
catalogImport.post("/preview", async (c) => {
  const read = await readUpload(c);
  if (read instanceof Response) return read;
  const tenantId = activeTenantId(c);
  const byRow = actions(read.plan);
  const locations = hasStock(read.plan)
    ? await StockService.listLocations(tenantId)
    : [];
  return c.json({
    summary: summarize(read.plan),
    errors: read.errors,
    ignored_columns: read.ignored_columns,
    rows: read.rows.flatMap((r) => {
      const action = byRow.get(r.row);
      return action ? [{ ...r, action }] : [];
    }),
    locations: locations.length > 1 ? locations : [],
  });
});

/** Writes the whole file, or nothing when any row has an error. */
catalogImport.post("/", async (c) => {
  const read = await readUpload(c);
  if (read instanceof Response) return read;
  const tenantId = activeTenantId(c);
  const user = c.get("user");
  if (read.errors.length > 0) {
    return c.json(
      {
        error: "Corrige las filas con error y vuelve a subir el archivo",
        errors: read.errors,
      },
      400,
    );
  }

  let locationId: string | null = null;
  if (hasStock(read.plan)) {
    const location = read.locationId
      ? await StockService.getLocation(tenantId, read.locationId)
      : await StockService.defaultLocation(tenantId);
    if (!location) {
      return c.json(
        { error: "Elige el almacén que recibe el stock del archivo" },
        400,
      );
    }
    locationId = location.id;
  }

  try {
    await applyImport(tenantId, read.plan, locationId, user.id);
  } catch (error) {
    if (error instanceof DuplicateSkuError) {
      return c.json(
        {
          error:
            "Otro cambio usó uno de estos SKU mientras tanto; vuelve a revisar el archivo",
        },
        409,
      );
    }
    throw error;
  }
  const summary = summarize(read.plan);
  await logAction(
    { userId: user.id, tenantId },
    "import_catalog",
    "product",
    null,
    summary,
  );
  return c.json(summary, 201);
});

export default catalogImport;
