import { Hono } from "hono";
import { jsonObject, pathParam } from "../lib/http.ts";
import { ProductService } from "../domains/catalog/index.ts";
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
import { logAction } from "../platform/audit/logger.ts";
import catalogImport from "./catalog-import.ts";
import {
  activeTenantId,
  requireRole,
  requireTenantScope,
} from "../middleware/auth.ts";

const catalog = new Hono();

const requireCatalogWrite = requireRole("admin", "developer", "supervisor");

const NOT_AN_OBJECT = "Request body must be a JSON object";

const PRODUCT_STATUSES: unknown[] = ["draft", "active", "archived"];
const INVALID_STATUS = "status must be draft, active or archived";

catalog.use("/*", requireTenantScope);
catalog.route("/import", catalogImport);

// ============ PRODUCTS (base templates) ============

catalog.get("/products", async (c) => {
  return c.json(await ProductService.getAll(activeTenantId(c)));
});

catalog.get("/products/categories", async (c) => {
  return c.json(await ProductService.getCategories(activeTenantId(c)));
});

catalog.get("/products/:id", async (c) => {
  const product = await ProductService.getById(
    activeTenantId(c),
    pathParam(c, "id"),
  );
  if (!product) return c.json({ error: "Product not found" }, 404);
  return c.json(product);
});

catalog.post("/products", requireCatalogWrite, async (c) => {
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
});

catalog.patch("/products/:id", requireCatalogWrite, async (c) => {
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
});

// ============ PRODUCT IMAGES ============

const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const limitImageUpload = bodyLimit({
  maxSize: MAX_IMAGE_UPLOAD_BYTES,
  onError: (c) => c.json({ error: "The image is larger than 10 MB" }, 413),
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

catalog.get("/products/:id/images", async (c) => {
  const tenantId = activeTenantId(c);
  const productId = pathParam(c, "id");
  if (!(await ProductService.getById(tenantId, productId))) {
    return c.json({ error: "Product not found" }, 404);
  }
  return c.json(await ProductImageService.list(tenantId, productId));
});

catalog.post(
  "/products/:id/images",
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

catalog.put("/products/:id/images/order", requireCatalogWrite, async (c) => {
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
});

catalog.put("/images/:id/variants", requireCatalogWrite, async (c) => {
  const user = c.get("user");
  const tenantId = activeTenantId(c);
  const id = pathParam(c, "id");
  const body = await jsonObject(c);
  const variantIds = body?.variant_ids;
  if (
    !Array.isArray(variantIds) ||
    !variantIds.every((variantId) => typeof variantId === "string")
  ) {
    return c.json({ error: "variant_ids must be a list of variant ids" }, 400);
  }

  const current = await ProductImageService.get(tenantId, id);
  if (!current) return c.json({ error: "Image not found" }, 404);
  const image = await ProductImageService.setVariants(tenantId, id, variantIds);
  if (!image) {
    return c.json(
      { error: "variant_ids must name variants of the image's product" },
      400,
    );
  }

  await logAction(
    { userId: user.id, tenantId },
    "tag_product_image",
    "product",
    image.product_id,
    { imageId: id, variantIds: image.variant_ids },
  );
  return c.json(image);
});

catalog.delete("/images/:id", requireCatalogWrite, async (c) => {
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
});

// ============ VARIANTS ============

catalog.get("/products/:id/variants", async (c) => {
  const tenantId = activeTenantId(c);
  const productId = pathParam(c, "id");
  if (!(await ProductService.getById(tenantId, productId))) {
    return c.json({ error: "Product not found" }, 404);
  }
  return c.json(await VariantService.listByProduct(tenantId, productId));
});

catalog.post("/products/:id/variants", requireCatalogWrite, async (c) => {
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
});

catalog.patch("/variants/:id", requireCatalogWrite, async (c) => {
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
});

export default catalog;
