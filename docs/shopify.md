# Shopify

A shop that sells on Shopify connects its store on the Catálogo page, and
VendeYa's catalog and stock follow it. An order confirmed in VendeYa is created
in Shopify.

## Connecting

The Shopify card asks for the store domain (`mitienda.myshopify.com`), the Admin
API access token of a Shopify custom app, and the webhook signing secret. The
custom app needs the `read_products`, `read_inventory` and `write_orders`
scopes.

The token and the webhook secret are stored encrypted in `tenant_secrets` under
`SECRETS_KEY`, like the TAYPI keys; the domain and the last sync time live in
`shopify_connections`. Saving checks the token against
`GET /admin/api/<version>/shop.json`; only a 401 or 403 refuses the save.

`SHOPIFY_BASE_URL` overrides the API host for tests and local probes; empty
means each store's own `https://<shop_domain>`.

## The import

"Sincronizar ahora" — and the first connect — runs `syncFromShopify` in
`apps/backend/src/domains/shopify/sync.ts`. It pages `products.json` by
`since_id` and upserts by `products.shopify_product_id` and
`product_variants.shopify_variant_id`, so a repeat import updates and never
duplicates:

- product: title, description (HTML stripped), status, `product_type` as the
  category and `vendor` as the brand;
- variant: option title ("M / Rojo"), SKU and price in cents;
- stock: `inventory_levels.json` summed over the store's locations, applied as
  `adjust` movements so the variant's sellable stock (on hand minus reserved)
  equals Shopify's `available`;
- the product's main photo, downloaded and stored like an uploaded image and
  keyed by `product_images.shopify_image_id`.

A variant Shopify no longer returns is switched off (`is_active = 0`), not
deleted, so its order lines still resolve.

Shopify's stock lands in the business's only stock location, or in a location
named "Shopify" created for it when the business has several.

## Webhooks

`POST /api/webhook/shopify/:tenantId` is public and verifies
`X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body) against the
business's webhook secret, in constant time, before reading the body. A bad
signature is a 401; a handler failure is a 500 so Shopify retries.

| Topic                     | Effect                                                        |
| ------------------------- | ------------------------------------------------------------- |
| `products/update`         | upserts the product like the import (stock refetched)         |
| `products/delete`         | archives the product — hidden from the assistant, not deleted |
| `inventory_levels/update` | adjusts the imported variant's stock to `available`           |

## Writing orders back

Confirming an order (`pending` → `confirmed`) inserts a `shopify_order_syncs`
row in the same batch, only when the business is connected and a line holds an
imported variant. The minute sweep's `dispatchDueShopifyOrderSyncs` claims due
rows and creates the order with `POST /admin/api/<version>/orders.json`:
imported lines go by their Shopify `variant_id`, other lines as custom items,
with the customer and the shipping address when present.

A success writes `orders.shopify_order_id`; a failure keeps the row `failed`
with `last_error` and retries with a backoff up to an hour. The order detail
(`shopify_sync`) shows the state.
