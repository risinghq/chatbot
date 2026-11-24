/**
 * A product's photos are ordered and the first is its cover. A photo may show
 * some of the product's variants; one that shows none is of the whole
 * product. A photo, its
 * asset row and its object belong to one business, and no other business can
 * read, reorder or delete them.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Product, ProductImage, ProductVariant } from "@vendeya/types";

import { imageStorage } from "../src/adapters/storage/images.ts";
import { getOne } from "./helpers/db.ts";
import {
  MAX_PRODUCT_IMAGES,
  ProductImageService,
} from "../src/domains/catalog/images.ts";
import { VariantService } from "../src/domains/catalog/variants.ts";
import { requireAuth } from "../src/middleware/auth.ts";
import { errorHandler } from "../src/middleware/error.ts";
import {
  createSession,
  generateSessionToken,
} from "../src/platform/auth/session.ts";
import catalogRoutes from "../src/routes/catalog.ts";
import { createMember, createTenantFixture } from "./helpers/tenancy.ts";

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api/catalog", catalogRoutes);
app.onError(errorHandler);

type Caller = (
  method: string,
  path: string,
  body?: unknown,
) => Response | Promise<Response>;

async function callerFor(name: string): Promise<{
  call: Caller;
  tenantId: string;
}> {
  const { tenantId } = await createTenantFixture(name);
  const { userId } = await createMember({ tenantId }, "admin");
  const token = generateSessionToken();
  await createSession(token, userId, tenantId);
  const call: Caller = (method, path, body) =>
    app.request(path, {
      method,
      headers: {
        Cookie: `session=${token}`,
        "X-Tenant-Id": tenantId,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body === undefined || body instanceof FormData
          ? body
          : JSON.stringify(body),
    });
  return { call, tenantId };
}

async function json<T>(response: Response, status: number): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

async function createProduct(call: Caller): Promise<Product> {
  return await json<Product>(
    await call("POST", "/api/catalog/products", {
      name: "Polo básico",
      category: "ropa",
    }),
    200,
  );
}

let counter = 0;

/** Writes an object and records it, as a finished upload does. */
async function addImage(
  tenantId: string,
  productId: string,
): Promise<ProductImage> {
  counter += 1;
  const imageId = counter.toString(16).padStart(16, "0");
  await imageStorage.put(tenantId, imageId, new TextEncoder().encode("jpeg"));
  return await ProductImageService.add({
    tenantId,
    productId,
    imageId,
    byteSize: 4,
    createdBy: null,
  });
}

const objectKey = (image: ProductImage) => image.url.replace(/^\/media\//, "");

describe("a product's photos", () => {
  let call: Caller;
  let tenantId: string;
  let product: Product;

  beforeEach(async () => {
    ({ call, tenantId } = await callerFor(`images-${crypto.randomUUID()}`));
    product = await createProduct(call);
  });

  it("list in the order they were added, with public urls", async () => {
    const first = await addImage(tenantId, product.id);
    const second = await addImage(tenantId, product.id);

    const images = await json<ProductImage[]>(
      await call("GET", `/api/catalog/products/${product.id}/images`),
      200,
    );

    expect(images.map((image) => image.id)).toEqual([first.id, second.id]);
    expect(images.map((image) => image.position)).toEqual([0, 1]);
    expect(first.url).toMatch(
      new RegExp(`^/media/${tenantId}/images/[0-9a-f]{16}\\.jpg$`),
    );
  });

  it("give the product list its cover, or null without photos", async () => {
    const products = async () =>
      await json<Product[]>(await call("GET", "/api/catalog/products"), 200);
    expect((await products())[0]?.cover_url).toBeNull();

    const first = await addImage(tenantId, product.id);
    await addImage(tenantId, product.id);

    expect((await products())[0]?.cover_url).toBe(first.url);
  });

  it("take a new cover when reordered", async () => {
    const first = await addImage(tenantId, product.id);
    const second = await addImage(tenantId, product.id);

    const images = await json<ProductImage[]>(
      await call("PUT", `/api/catalog/products/${product.id}/images/order`, {
        ids: [second.id, first.id],
      }),
      200,
    );

    expect(images.map((image) => image.id)).toEqual([second.id, first.id]);
    const products = await json<Product[]>(
      await call("GET", "/api/catalog/products"),
      200,
    );
    expect(products[0]?.cover_url).toBe(second.url);
  });

  it("refuse an order that misses, repeats or adds an image", async () => {
    const first = await addImage(tenantId, product.id);
    const second = await addImage(tenantId, product.id);
    const path = `/api/catalog/products/${product.id}/images/order`;

    for (const ids of [
      [first.id],
      [first.id, first.id],
      [first.id, second.id, crypto.randomUUID()],
    ]) {
      expect((await call("PUT", path, { ids })).status).toBe(400);
    }
  });

  it("delete the row, the asset and the object together", async () => {
    const image = await addImage(tenantId, product.id);

    await json(await call("DELETE", `/api/catalog/images/${image.id}`), 200);

    expect(await ProductImageService.list(tenantId, product.id)).toEqual([]);
    expect(
      await getOne(`SELECT id FROM assets WHERE tenant_id = ? AND id = ?`, [
        tenantId,
        image.asset_id,
      ]),
    ).toBeFalsy();
    const imageId = objectKey(image).split("/")[2]!.replace(".jpg", "");
    expect(await imageStorage.exists(tenantId, imageId)).toBe(false);
  });

  it(`stop at ${MAX_PRODUCT_IMAGES}`, async () => {
    for (let i = 0; i < MAX_PRODUCT_IMAGES; i++) {
      await addImage(tenantId, product.id);
    }
    const form = new FormData();
    form.append("image", new File([new Uint8Array(8)], "x.jpg"));

    const response = await call(
      "POST",
      `/api/catalog/products/${product.id}/images`,
      form,
    );

    expect(response.status).toBe(409);
  });

  it("refuse an upload with no image field", async () => {
    const response = await call(
      "POST",
      `/api/catalog/products/${product.id}/images`,
      new FormData(),
    );
    expect(response.status).toBe(400);
  });
});

describe("another business", () => {
  it("cannot list, reorder or delete a product's photos", async () => {
    const owner = await callerFor(`owner-${crypto.randomUUID()}`);
    const other = await callerFor(`other-${crypto.randomUUID()}`);
    const product = await createProduct(owner.call);
    const image = await addImage(owner.tenantId, product.id);

    expect(
      (await other.call("GET", `/api/catalog/products/${product.id}/images`))
        .status,
    ).toBe(404);
    expect(
      (
        await other.call(
          "PUT",
          `/api/catalog/products/${product.id}/images/order`,
          { ids: [image.id] },
        )
      ).status,
    ).toBe(404);
    expect(
      (await other.call("DELETE", `/api/catalog/images/${image.id}`)).status,
    ).toBe(404);
    expect(
      await ProductImageService.list(owner.tenantId, product.id),
    ).toHaveLength(1);
  });

  it("cannot be given a photo of the owner's asset", async () => {
    const owner = await callerFor(`owner-${crypto.randomUUID()}`);
    const other = await callerFor(`other-${crypto.randomUUID()}`);
    const product = await createProduct(owner.call);

    await expect(addImage(other.tenantId, product.id)).rejects.toThrow();
  });
});

describe("photos per variant", () => {
  let call: Caller;
  let tenantId: string;
  let product: Product;
  let red: ProductVariant;
  let black: ProductVariant;

  const variant = (productId: string, name: string) =>
    VariantService.create(tenantId, productId, {
      name,
      sku: `SKU-${crypto.randomUUID().slice(0, 8)}`,
      price_cents: 4990,
      cost_cents: null,
      is_active: 1,
    });
  const tag = (image: ProductImage, variantIds: string[]) =>
    call("PUT", `/api/catalog/images/${image.id}/variants`, {
      variant_ids: variantIds,
    });

  beforeEach(async () => {
    ({ call, tenantId } = await callerFor(`tags-${crypto.randomUUID()}`));
    product = await createProduct(call);
    red = await variant(product.id, "M / Rojo");
    black = await variant(product.id, "M / Negro");
  });

  it("start as whole-product photos and keep the variants they are given", async () => {
    const image = await addImage(tenantId, product.id);
    expect(image.variant_ids).toEqual([]);

    const tagged = await json<ProductImage>(await tag(image, [red.id]), 200);
    expect(tagged.variant_ids).toEqual([red.id]);
    const [listed] = await ProductImageService.list(tenantId, product.id);
    expect(listed?.variant_ids).toEqual([red.id]);

    const cleared = await json<ProductImage>(await tag(image, []), 200);
    expect(cleared.variant_ids).toEqual([]);
  });

  it("send a variant its own photos first and never another variant's", async () => {
    const whole = await addImage(tenantId, product.id);
    const blackPhoto = await addImage(tenantId, product.id);
    const redPhoto = await addImage(tenantId, product.id);
    await json(await tag(blackPhoto, [black.id]), 200);
    await json(await tag(redPhoto, [red.id]), 200);

    expect(
      await ProductImageService.storageKeys(tenantId, product.id, 3, red.id),
    ).toEqual([objectKey(redPhoto), objectKey(whole)]);
    expect(
      await ProductImageService.storageKeys(tenantId, product.id, 3),
    ).toEqual([objectKey(whole), objectKey(blackPhoto), objectKey(redPhoto)]);
  });

  it("refuse a variant of another product and keep the old tags", async () => {
    const image = await addImage(tenantId, product.id);
    const otherProduct = await createProduct(call);
    const foreign = await variant(otherProduct.id, "L");

    expect((await tag(image, [red.id, foreign.id])).status).toBe(400);
    const [listed] = await ProductImageService.list(tenantId, product.id);
    expect(listed?.variant_ids).toEqual([]);
  });

  it("cannot be tagged by another business", async () => {
    const image = await addImage(tenantId, product.id);
    const other = await callerFor(`other-${crypto.randomUUID()}`);

    const response = await other.call(
      "PUT",
      `/api/catalog/images/${image.id}/variants`,
      { variant_ids: [] },
    );
    expect(response.status).toBe(404);
  });
});
