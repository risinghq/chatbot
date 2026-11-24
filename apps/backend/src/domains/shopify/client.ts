import { shopifyBaseUrl, type ShopifyLogin } from "./connection.ts";

/** The Admin API version every call and webhook subscription pins. */
export const SHOPIFY_API_VERSION = "2025-01";

/** A Shopify answer other than 2xx. */
export class ShopifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type ShopifyVariant = {
  id: number;
  product_id: number;
  title: string;
  sku: string | null;
  price: string;
  inventory_item_id: number;
};

export type ShopifyProduct = {
  id: number;
  title: string;
  body_html: string | null;
  status: string;
  product_type: string;
  vendor: string;
  variants: ShopifyVariant[];
  image: { id: number; src: string } | null;
};

export type InventoryLevel = {
  inventory_item_id: number;
  location_id: number;
  available: number;
};

const API_PREFIX = `/admin/api/${SHOPIFY_API_VERSION}`;

/** One Admin API call against the store's base URL. */
async function callRaw(
  login: ShopifyLogin,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Response> {
  const response = await fetch(
    `${shopifyBaseUrl(login.shop_domain)}${API_PREFIX}${path}`,
    {
      method,
      headers: {
        "X-Shopify-Access-Token": login.accessToken,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const message =
      typeof json?.errors === "string"
        ? json.errors
        : `Shopify answered ${response.status}`;
    throw new ShopifyError(response.status, message);
  }
  return response;
}

async function call<T>(
  login: ShopifyLogin,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  return (await (await callRaw(login, method, path, body)).json()) as T;
}

/** The `rel="next"` href of a `Link` header, or null on the last page. */
function nextPage(link: string | null): string | null {
  const match = link?.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  const url = new URL(match[1]!);
  return url.pathname.replace(API_PREFIX, "") + url.search;
}

export const ShopifyApi = {
  /** The shop the token opens; connect checks the credentials with it. */
  shop: (login: ShopifyLogin) =>
    call<{ shop: { name: string; myshopify_domain: string } }>(
      login,
      "GET",
      "/shop.json",
    ),

  /**
   * Every product of the store, oldest id first, paged by `since_id` so a
   * store bigger than one page still comes in order.
   */
  products: async (
    login: ShopifyLogin,
    sinceId = 0,
  ): Promise<ShopifyProduct[]> => {
    const page = await call<{ products: ShopifyProduct[] }>(
      login,
      "GET",
      `/products.json?limit=250&since_id=${sinceId}`,
    );
    return page.products;
  },

  /**
   * The sellable stock of each inventory item, one row per Shopify location,
   * paged until the Link header stops naming a next page: a store with
   * several locations returns a row per item per location. The caller passes
   * at most 50 ids, Shopify's limit for the parameter.
   */
  inventoryLevels: async (
    login: ShopifyLogin,
    inventoryItemIds: string[],
  ): Promise<InventoryLevel[]> => {
    const levels: InventoryLevel[] = [];
    let path: string | null =
      `/inventory_levels.json?limit=250&inventory_item_ids=${inventoryItemIds.join(",")}`;
    while (path !== null) {
      const response = await callRaw(login, "GET", path);
      const page = (await response.json()) as {
        inventory_levels: InventoryLevel[];
      };
      levels.push(...page.inventory_levels);
      path = nextPage(response.headers.get("link"));
    }
    return levels;
  },

  /** Downloads bytes, such as a product photo. Not an Admin API call. */
  download: async (
    url: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new ShopifyError(
        response.status,
        `Download answered ${response.status}`,
      );
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "",
    };
  },

  /**
   * Files a confirmed VendeYa order as a Shopify order. Imported lines go by
   * their variant id so Shopify moves its own inventory; the rest ride as
   * custom items.
   */
  createOrder: (
    login: ShopifyLogin,
    order: {
      name: string;
      note: string | null;
      customer: { first_name: string; phone?: string } | null;
      line_items: (
        | { variant_id: number; quantity: number }
        | { title: string; price: string; quantity: number }
      )[];
      shipping_address?: {
        name: string;
        phone: string | null;
        address1: string;
        city: string | null;
      };
    },
  ) =>
    call<{ order: { id: number } }>(login, "POST", "/orders.json", {
      order: { financial_status: "pending", source_name: "vendeya", ...order },
    }),
};
