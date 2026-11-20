import { Hono } from "hono";
import { jsonObject, pathParam } from "../lib/http.ts";
import {
  ProductService,
  BundleService,
  bundleFieldsError,
} from "../domains/catalog/index.ts";
import { PeriodService } from "../domains/catalog/periods.ts";
import {
  parseVariantFields,
  VariantService,
  type VariantFields,
} from "../domains/catalog/variants.ts";
import {
  MAX_PRODUCT_IMAGES,
  ProductImageService,
} from "../domains/catalog/images.ts";
import { bodyLimit } from "hono/body-limit";
import { imageStorage, isUnreadableImage } from "../adapters/storage/images.ts";
import { AssetService } from "../domains/assets/index.ts";
import { logAction } from "../platform/audit/logger.ts";
import {
  activeTenantId,
  requireActiveTenant,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";

const catalog = new Hono();

const requireCatalogWrite = requireRole("admin", "developer", "supervisor");

const NOT_AN_OBJECT = "Request body must be a JSON object";

const PRODUCT_STATUSES: unknown[] = ["draft", "active", "archived"];
const INVALID_STATUS = "status must be draft, active or archived";

// Reads use the pinned tenant, or every open tenant for an unpinned platform
// operator. Writes additionally need a pinned tenant to write into.
catalog.use("/*", requireTenantScope);

// ============ PRODUCTS (base templates) ============

catalog.get("/products", async (c) => {
  return c.json(await ProductService.getAll(c.get("scope").tenantId));
});

catalog.get("/products/categories", async (c) => {
  return c.json(await ProductService.getCategories(c.get("scope").tenantId));
});

catalog.get("/products/:id", async (c) => {
  const product = await ProductService.getById(
    c.get("scope").tenantId,
    pathParam(c, "id"),
  );
  if (!product) return c.json({ error: "Product not found" }, 404);
  return c.json(product);
});

catalog.post(
  "/products",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const { name, category, description, status, brand, model, specs_json } =
      await c.req.json();

    if (!name || !category) {
      return c.json({ error: "Name and category required" }, 400);
    }
    if (status !== undefined && !PRODUCT_STATUSES.includes(status)) {
      return c.json({ error: INVALID_STATUS }, 400);
    }

    const product = await ProductService.create({
      tenantId,
      name,
      category,
      description,
      status,
      brand,
      model,
      specs_json,
    });

    await logAction(
      { userId: user.id, tenantId },
      "create_product",
      "product",
      product.id,
      {
        name,
        category,
      },
    );
    return c.json(product);
  },
);

catalog.patch(
  "/products/:id",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const id = pathParam(c, "id");
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const updates = await c.req.json();
    if (
      updates.status !== undefined &&
      !PRODUCT_STATUSES.includes(updates.status)
    ) {
      return c.json({ error: INVALID_STATUS }, 400);
    }

    const product = await ProductService.update(tenantId, id, updates);
    if (!product) return c.json({ error: "Product not found" }, 404);

    await logAction(
      { userId: user.id, tenantId },
      "update_product",
      "product",
      id,
      updates,
    );
    return c.json(product);
  },
);

// ============ PRODUCT IMAGES ============

const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const limitImageUpload = bodyLimit({
  maxSize: MAX_IMAGE_UPLOAD_BYTES,
  onError: (c) => c.json({ error: "The image is larger than 10 MB" }, 413),
});

catalog.get("/products/:id/images", requireActiveTenant, async (c) => {
  const tenantId = activeTenantId(c);
  const productId = pathParam(c, "id");
  if (!(await ProductService.getById(tenantId, productId))) {
    return c.json({ error: "Product not found" }, 404);
  }
  return c.json(await ProductImageService.list(tenantId, productId));
});

catalog.post(
  "/products/:id/images",
  requireActiveTenant,
  requireCatalogWrite,
  limitImageUpload,
  async (c) => {
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const productId = pathParam(c, "id");
    const file = (await c.req.parseBody()).image;
    if (!(file instanceof File)) {
      return c.json(
        { error: "Send the image as the multipart field image" },
        400,
      );
    }

    if (!(await ProductService.getById(tenantId, productId))) {
      return c.json({ error: "Product not found" }, 404);
    }
    const existing = await ProductImageService.list(tenantId, productId);
    if (existing.length >= MAX_PRODUCT_IMAGES) {
      return c.json(
        { error: `A product holds at most ${MAX_PRODUCT_IMAGES} images` },
        409,
      );
    }

    const stored = await storeImage(tenantId, file);
    if (!stored) return c.json({ error: NOT_AN_IMAGE }, 400);

    const image = await ProductImageService.add({
      tenantId,
      productId,
      imageId: stored.imageId,
      byteSize: stored.byteSize,
      createdBy: user.id,
    });

    await logAction(
      { userId: user.id, tenantId },
      "add_product_image",
      "product",
      productId,
      { imageId: image.id },
    );
    return c.json(image);
  },
);

catalog.put(
  "/products/:id/images/order",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const productId = pathParam(c, "id");
    const body = await jsonObject(c);
    const ids = body?.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
      return c.json({ error: "ids must be a list of image ids" }, 400);
    }

    if (!(await ProductService.getById(tenantId, productId))) {
      return c.json({ error: "Product not found" }, 404);
    }
    const images = await ProductImageService.reorder(tenantId, productId, ids);
    if (!images) {
      return c.json(
        { error: "ids must name each of the product's images once" },
        400,
      );
    }

    await logAction(
      { userId: user.id, tenantId },
      "reorder_product_images",
      "product",
      productId,
      { ids },
    );
    return c.json(images);
  },
);

catalog.delete(
  "/images/:id",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const id = pathParam(c, "id");
    const image = await ProductImageService.get(tenantId, id);
    if (!image) return c.json({ error: "Image not found" }, 404);

    await ProductImageService.remove(tenantId, id);
    await logAction(
      { userId: user.id, tenantId },
      "delete_product_image",
      "product",
      image.product_id,
      { imageId: id },
    );
    return c.json({ success: true });
  },
);

// ============ VARIANTS ============

catalog.get("/products/:id/variants", requireActiveTenant, async (c) => {
  const tenantId = activeTenantId(c);
  const productId = pathParam(c, "id");
  if (!(await ProductService.getById(tenantId, productId))) {
    return c.json({ error: "Product not found" }, 404);
  }
  return c.json(await VariantService.listByProduct(tenantId, productId));
});

catalog.post(
  "/products/:id/variants",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const tenantId = activeTenantId(c);
    const productId = pathParam(c, "id");
    const body = await jsonObject(c);
    if (!body) return c.json({ error: NOT_AN_OBJECT }, 400);

    const fields = parseVariantFields(body, false);
    if (typeof fields === "string") return c.json({ error: fields }, 400);
    if (!(await ProductService.getById(tenantId, productId))) {
      return c.json({ error: "Product not found" }, 404);
    }

    const variant = await VariantService.create(tenantId, productId, {
      name: null,
      cost_cents: null,
      is_active: 1,
      ...(fields as Pick<VariantFields, "sku" | "price_cents">),
    });

    await logAction(
      { userId: c.get("user").id, tenantId },
      "create_variant",
      "product_variant",
      variant.id,
      { product_id: productId, sku: variant.sku },
    );
    return c.json(variant, 201);
  },
);

catalog.patch(
  "/variants/:id",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const tenantId = activeTenantId(c);
    const id = pathParam(c, "id");
    const body = await jsonObject(c);
    if (!body) return c.json({ error: NOT_AN_OBJECT }, 400);

    const fields = parseVariantFields(body, true);
    if (typeof fields === "string") return c.json({ error: fields }, 400);

    const variant = await VariantService.update(tenantId, id, fields);
    if (!variant) return c.json({ error: "Variant not found" }, 404);

    await logAction(
      { userId: c.get("user").id, tenantId },
      "update_variant",
      "product_variant",
      id,
      fields,
    );
    return c.json(variant);
  },
);

// ============ BUNDLES ============

catalog.get("/bundles", async (c) => {
  const scope = c.get("scope");
  const periodId = c.req.query("period_id");
  const maxPrice = c.req.query("max_price");
  const category = c.req.query("category");
  const segment = c.req.query("segment") as "gaso" | "fnb" | undefined;

  if (periodId) {
    return c.json(
      await BundleService.getByPeriod(scope.tenantId, periodId, segment),
    );
  }

  if (!scope.tenantId) {
    // "Currently available" only means something inside one tenant's active
    // period, so an unpinned platform operator must select a tenant first.
    return c.json(
      { error: "Select a tenant, or pass period_id, to list bundles" },
      400,
    );
  }

  return c.json(
    await BundleService.getAvailable(scope.tenantId, {
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      category: category || undefined,
      segment,
    }),
  );
});

catalog.get("/bundles/categories", requireActiveTenant, async (c) => {
  const segment = c.req.query("segment") as "gaso" | "fnb" | undefined;
  return c.json(
    await BundleService.getAvailableCategories(activeTenantId(c), segment),
  );
});

catalog.get("/bundles/:id", async (c) => {
  const bundle = await BundleService.getById(
    c.get("scope").tenantId,
    pathParam(c, "id"),
  );
  if (!bundle) return c.json({ error: "Bundle not found" }, 404);
  return c.json(bundle);
});

const NOT_AN_IMAGE = "The file is not an image";

/** The stored image, or null when the Images binding cannot read the file. */
async function storeImage(
  tenantId: string,
  file: File,
): Promise<{ imageId: string; byteSize: number } | null> {
  try {
    return await imageStorage.store(
      tenantId,
      new Uint8Array(await file.arrayBuffer()),
    );
  } catch (error) {
    if (isUnreadableImage(error)) return null;
    throw error;
  }
}

catalog.post(
  "/bundles",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const body = await c.req.parseBody();

    const file = body.image as File;
    if (!file) return c.json({ error: "Image required" }, 400);

    const periodId = body.period_id as string;
    const segment = (body.segment as string) || "gaso";
    const name = body.name as string;
    const price = body.price as string;
    const primaryCategory = body.primary_category as string;
    const categoriesJson = body.categories_json as string;
    const compositionJson = body.composition_json as string;
    const installmentsJson = body.installments_json as string;

    if (
      !periodId ||
      !name ||
      !price ||
      !primaryCategory ||
      !compositionJson ||
      !installmentsJson
    ) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    const fieldsError = bundleFieldsError({
      name,
      price: Number(price),
      primary_category: primaryCategory,
      composition_json: compositionJson,
      installments_json: installmentsJson,
    });
    if (fieldsError) return c.json({ error: fieldsError }, 400);
    if (segment !== "gaso" && segment !== "fnb") {
      return c.json({ error: "segment must be gaso or fnb" }, 400);
    }

    const period = await PeriodService.getById(tenantId, periodId);
    if (!period) return c.json({ error: "Period not found" }, 404);
    if (period.status !== "draft") {
      return c.json({ error: "Can only add bundles to draft periods" }, 400);
    }

    const stored = await storeImage(tenantId, file);
    if (!stored) return c.json({ error: NOT_AN_IMAGE }, 400);
    const { imageId, byteSize } = stored;

    // Catalog images are public by design because Meta fetches them when we
    // send an image message. The asset row still records who owns them.
    await AssetService.create({
      tenantId,
      kind: "catalog_image",
      visibility: "public",
      storageKey: imageStorage.storageKey(tenantId, imageId),
      contentType: "image/jpeg",
      byteSize,
      createdBy: user.id,
    });

    const id = `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bundle = await BundleService.create({
      id,
      tenantId,
      period_id: periodId,
      segment: segment as "gaso" | "fnb",
      name,
      price: Number(price),
      primary_category: primaryCategory,
      categories_json: categoriesJson || "[]",
      image_id: imageId,
      composition_json: compositionJson,
      installments_json: installmentsJson,
      created_by: user.id,
    });

    await logAction(
      { userId: user.id, tenantId },
      "create_bundle",
      "bundle",
      id,
      {
        name,
        price,
        primaryCategory,
        segment,
      },
    );
    return c.json(bundle);
  },
);

catalog.patch(
  "/bundles/:id",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const id = pathParam(c, "id");
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const updates = await jsonObject(c);
    if (!updates) return c.json({ error: NOT_AN_OBJECT }, 400);

    const fieldsError = bundleFieldsError(updates);
    if (fieldsError) return c.json({ error: fieldsError }, 400);

    const bundle = await BundleService.update(tenantId, id, updates);
    if (!bundle) return c.json({ error: "Bundle not found" }, 404);

    await logAction(
      { userId: user.id, tenantId },
      "update_bundle",
      "bundle",
      id,
      updates,
    );
    return c.json(bundle);
  },
);

catalog.post(
  "/bundles/:id/image",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const id = pathParam(c, "id");
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const body = await c.req.parseBody();

    const file = body.image as File;
    if (!file) return c.json({ error: "Image required" }, 400);

    const existing = await BundleService.getById(tenantId, id);
    if (!existing) return c.json({ error: "Bundle not found" }, 404);

    const period = await PeriodService.getById(tenantId, existing.period_id);
    if (period && period.status !== "draft") {
      return c.json({ error: "Can only edit bundles in draft periods" }, 400);
    }

    const stored = await storeImage(tenantId, file);
    if (!stored) return c.json({ error: NOT_AN_IMAGE }, 400);
    const { imageId, byteSize } = stored;

    await AssetService.create({
      tenantId,
      kind: "catalog_image",
      visibility: "public",
      storageKey: imageStorage.storageKey(tenantId, imageId),
      contentType: "image/jpeg",
      byteSize,
      createdBy: user.id,
    });

    const bundle = await BundleService.updateImage(tenantId, id, imageId);

    await logAction(
      { userId: user.id, tenantId },
      "update_bundle_image",
      "bundle",
      id,
    );
    return c.json(bundle);
  },
);

catalog.delete(
  "/bundles/:id",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const id = pathParam(c, "id");
    const user = c.get("user");
    const tenantId = activeTenantId(c);

    if (!(await BundleService.getById(tenantId, id))) {
      return c.json({ error: "Bundle not found" }, 404);
    }

    await BundleService.delete(tenantId, id);
    await logAction(
      { userId: user.id, tenantId },
      "delete_bundle",
      "bundle",
      id,
    );
    return c.json({ success: true });
  },
);

catalog.post(
  "/bundles/bulk-update",
  requireActiveTenant,
  requireCatalogWrite,
  async (c) => {
    const user = c.get("user");
    const tenantId = activeTenantId(c);
    const body = await jsonObject(c);
    if (!body) return c.json({ error: NOT_AN_OBJECT }, 400);

    const { ids, updates } = body;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => typeof id === "string")
    ) {
      return c.json({ error: "ids must be a non-empty array of ids" }, 400);
    }

    if (
      updates === null ||
      typeof updates !== "object" ||
      Array.isArray(updates)
    ) {
      return c.json({ error: "updates must be an object" }, 400);
    }

    // Bulk updates support only these two columns.
    const { is_active, stock_status } = updates as Record<string, unknown>;
    if (is_active === undefined && stock_status === undefined) {
      return c.json(
        { error: "updates must set is_active or stock_status" },
        400,
      );
    }
    const fieldsError = bundleFieldsError({ is_active, stock_status });
    if (fieldsError) return c.json({ error: fieldsError }, 400);

    const count = await BundleService.bulkUpdate(tenantId, ids, updates);
    await logAction(
      { userId: user.id, tenantId },
      "bulk_update_bundles",
      "bundle",
      null,
      { count, ids, updates },
    );
    return c.json({ success: true, count });
  },
);

export default catalog;
