import { vi } from "vitest";
import { TEST_BINDINGS } from "../bindings.ts";

export type ShopifyCall = {
  method: string;
  path: string;
  token: string | null;
  payload: Record<string, unknown> | null;
};

/**
 * Stands in for a store's Admin API. Every `fetch` to SHOPIFY_BASE_URL is
 * recorded and answered from `store`: its products, the inventory levels of
 * the ids asked for, the bytes of /cdn/* image URLs, and a created order.
 * Any other URL fails the test, so nothing reaches the network.
 */
export function fakeShopify(store: {
  products?: unknown[];
  inventoryLevels?: {
    inventory_item_id: number;
    available: number;
    location_id?: number;
  }[];
  orderId?: number;
  /** Caps the rows an inventory_levels page returns, to exercise paging. */
  pageSize?: number;
}) {
  const calls: ShopifyCall[] = [];
  let orderResponse: Response | null = null;

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== TEST_BINDINGS.SHOPIFY_BASE_URL) {
        throw new Error(`Unexpected fetch to ${request.url}`);
      }
      const path = url.pathname + url.search;
      const payload =
        request.method === "GET"
          ? null
          : ((await request.json()) as Record<string, unknown>);
      calls.push({
        method: request.method,
        path,
        token: request.headers.get("x-shopify-access-token"),
        payload,
      });

      if (url.pathname === "/admin/api/2025-01/shop.json") {
        return Response.json({
          shop: {
            name: "Tienda de prueba",
            myshopify_domain: "t.myshopify.com",
          },
        });
      }
      if (url.pathname === "/admin/api/2025-01/products.json") {
        const since = Number(url.searchParams.get("since_id") ?? 0);
        const products = (store.products ?? []).filter(
          (p) => (p as { id: number }).id > since,
        );
        return Response.json({ products });
      }
      if (url.pathname === "/admin/api/2025-01/inventory_levels.json") {
        const wanted = new Set(
          (url.searchParams.get("inventory_item_ids") ?? "").split(","),
        );
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? 50),
          store.pageSize ?? 250,
        );
        const start = Number(url.searchParams.get("page_info") ?? 0);
        const all = (store.inventoryLevels ?? [])
          .filter((l) => wanted.has(String(l.inventory_item_id)))
          .map((l) => ({ location_id: 9001, ...l }));
        const levels = all.slice(start, start + limit);
        const next = start + limit;
        const headers = new Headers();
        if (next < all.length) {
          const nextUrl = new URL(request.url);
          nextUrl.searchParams.set("page_info", String(next));
          headers.set("link", `<${nextUrl}>; rel="next"`);
        }
        return Response.json({ inventory_levels: levels }, { headers });
      }
      if (url.pathname === "/admin/api/2025-01/orders.json") {
        if (orderResponse) return orderResponse;
        return Response.json(
          { order: { id: store.orderId ?? 51234 } },
          { status: 201 },
        );
      }
      if (url.pathname.startsWith("/cdn/")) {
        return new Response(new TextEncoder().encode("jpeg-bytes"), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      throw new Error(`Unexpected Shopify call to ${path}`);
    });

  return {
    calls,
    /** The calls to one path, such as /admin/api/2025-01/orders.json. */
    to(path: string): ShopifyCall[] {
      return calls.filter((c) => c.path === path);
    },
    /** Answers the next order creates with `response`, then the default. */
    failOrders(status = 500) {
      orderResponse = Response.json({ errors: "broken" }, { status });
    },
    succeedOrders() {
      orderResponse = null;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

/** A real-shaped Shopify product for the fake. */
export function shopifyProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 7001,
    title: "Polo clásico",
    body_html: "<p>Polo de algodón</p>",
    status: "active",
    product_type: "Ropa",
    vendor: "Marca",
    image: { id: 555, src: "https://shopify.test/cdn/polo.jpg" },
    variants: [
      {
        id: 8001,
        product_id: 7001,
        title: "M / Rojo",
        sku: "POLO-M-ROJO",
        price: "49.90",
        inventory_item_id: 90001,
      },
      {
        id: 8002,
        product_id: 7001,
        title: "L / Rojo",
        sku: "POLO-L-ROJO",
        price: "49.90",
        inventory_item_id: 90002,
      },
    ],
    ...overrides,
  };
}

/** Signs a webhook body the way Shopify does: base64 HMAC-SHA256. */
export async function shopifySignature(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  let binary = "";
  for (const b of new Uint8Array(mac)) binary += String.fromCharCode(b);
  return btoa(binary);
}
